#!/usr/bin/env node
/**
 * engineering-assets/tools/gate-runner.cjs — CBB 生产级准入门 runner (MVP)
 *
 * 依据《CBB 库治理与生产级准入规范 V1.0》§7.1 十条 MVP 硬门。
 * 只跑可确定性机器判 + iverilog(若可用) 的门；tool 类(Vivado/CDC/bit-true cosim)
 * 在未接线时标 blocked，绝不当作 pass —— 无法认证也不静默放行。
 *
 * 用法: node gate-runner.cjs <asset-package-dir> [--repo-root <dir>]
 *   asset 包内须有 manifest.json + sources[] 指向的 rtl 文件。
 * 退出码: 0=达到 certified 资格; 1=有 MUST 门未过(正常的"未认证"结果); 2=用法/致命错误。
 *
 * 无外部依赖(ajv 为规模化路径)。自带极简 draft-07 子集校验器。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

// ── 极简 JSON-Schema 校验器 (支持本项目用到的子集) ─────────────────────────
function validate(schema, data, p = '$', errs = []) {
  if (!schema) return errs;
  const t = schema.type;
  const types = Array.isArray(t) ? t : t ? [t] : [];
  const jt = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
  const norm = jt === 'number' && Number.isInteger(data) ? ['number', 'integer'] : [jt];
  if (types.length && !types.some((x) => norm.includes(x))) {
    errs.push(`${p}: 期望类型 ${types.join('|')}, 实为 ${jt}`); return errs;
  }
  if (schema.enum && !schema.enum.includes(data)) errs.push(`${p}: 值 ${JSON.stringify(data)} 不在 enum ${JSON.stringify(schema.enum)}`);
  if (typeof data === 'string' && schema.pattern && !new RegExp(schema.pattern).test(data)) errs.push(`${p}: 不匹配 pattern ${schema.pattern}`);
  if (typeof data === 'number' && schema.minimum != null && data < schema.minimum) errs.push(`${p}: < minimum ${schema.minimum}`);
  if (jt === 'array') {
    if (schema.minItems != null && data.length < schema.minItems) errs.push(`${p}: 少于 minItems ${schema.minItems}`);
    if (schema.items) data.forEach((v, i) => validate(schema.items, v, `${p}[${i}]`, errs));
  }
  if (jt === 'object') {
    (schema.required || []).forEach((k) => { if (!(k in data)) errs.push(`${p}: 缺必填字段 '${k}'`); });
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      Object.keys(data).forEach((k) => { if (!(k in props)) errs.push(`${p}: 不允许的额外字段 '${k}'`); });
    }
    Object.keys(props).forEach((k) => { if (k in data) validate(props[k], data[k], `${p}.${k}`, errs); });
  }
  return errs;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const BUS_RE = /_axis_|_axi_|^wb_|^s_wb_|^m_wb_|^tck$|^tms$|^tdi$|^tdo$/i; // 协议豁免
function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); }
function alwaysBlocks(code) {
  // 返回 [{start,len}] 每个 always 块的起始行与行数(按 begin/end 深度)
  const lines = code.split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\balways(_ff|_comb|_latch)?\b/.test(lines[i])) {
      let depth = 0, started = false, j = i;
      for (; j < lines.length; j++) {
        const opens = (lines[j].match(/\bbegin\b/g) || []).length;
        const closes = (lines[j].match(/\bend\b/g) || []).length;
        depth += opens - closes; if (opens) started = true;
        if (started && depth <= 0) break;
        if (!started && /;/.test(lines[j]) && j > i) break; // 单语句 always
      }
      out.push({ start: i + 1, len: j - i + 1 });
    }
  }
  return out;
}

// ── 门禁实现 ─────────────────────────────────────────────────────────────
function runGates(pkgDir, manifest, repoRoot) {
  const gates = [];
  const add = (g) => gates.push(g);
  const rtlSrcs = (manifest.sources || []).filter((s) => s.role === 'rtl');
  const rtlAbs = rtlSrcs.map((s) => path.join(pkgDir, s.path));
  const rtlText = rtlAbs.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')).join('\n');
  const code = stripComments(rtlText);

  // CS-2 源 sha256 + 无未登记 rtl
  (() => {
    const bad = [];
    for (const s of manifest.sources) {
      const abs = path.join(pkgDir, s.path);
      if (!fs.existsSync(abs)) { bad.push(`${s.path}: 文件缺失`); continue; }
      const actual = sha256(fs.readFileSync(abs));
      if (actual !== s.sha256) bad.push(`${s.path}: sha256 不符 (声明 ${s.sha256.slice(0, 12)}… 实为 ${actual.slice(0, 12)}…)`);
    }
    const rtlDir = path.join(pkgDir, 'rtl');
    const declared = new Set(manifest.sources.map((s) => path.resolve(path.join(pkgDir, s.path))));
    if (fs.existsSync(rtlDir)) for (const f of fs.readdirSync(rtlDir)) {
      if (/\.(v|sv|vh)$/i.test(f) && !declared.has(path.resolve(path.join(rtlDir, f)))) bad.push(`rtl/${f}: 未登记源文件`);
    }
    add({ id: 'CS-2', name: '源哈希+无未登记文件', level: 'intake', must: true, status: bad.length ? 'fail' : 'pass', severity: 'high', detail: bad.length ? bad : '全部源 sha256 匹配' });
  })();

  // G-A-00 lint — 优先 ModelSim vlog (用户工具链), 回退 iverilog
  (() => {
    const build = path.join(repoRoot, 'engineering-assets', 'var', 'build', 'lint', manifest.asset_uid || 'x');
    try { fs.rmSync(build, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(build, { recursive: true });
    const vlib = cp.spawnSync('vlib', ['work'], { cwd: build, encoding: 'utf8' });
    if (!(vlib.error && vlib.error.code === 'ENOENT')) {
      const vlog = cp.spawnSync('vlog', ['-sv', '-quiet', '-work', 'work', ...rtlAbs.map((f) => path.resolve(f))], { cwd: build, encoding: 'utf8' });
      const out = `${vlog.stdout || ''}${vlog.stderr || ''}`;
      const mm = out.match(/Errors:\s*(\d+),\s*Warnings:\s*(\d+)/);
      const errs = mm ? parseInt(mm[1], 10) : (vlog.status === 0 ? 0 : 1);
      const warns = mm ? parseInt(mm[2], 10) : 0;
      add({ id: 'G-A-00', name: 'ModelSim vlog lint', level: 'intake', must: true, status: errs === 0 ? 'pass' : 'fail', severity: 'high', detail: errs === 0 ? `vlog 编译干净 (Errors:0 Warnings:${warns})` : out.split('\n').filter((l) => /error/i.test(l)).slice(0, 12) });
      return;
    }
    const iv = cp.spawnSync('iverilog', ['-g2012', '-t', 'null', ...rtlAbs], { encoding: 'utf8' });
    if (iv.error && iv.error.code === 'ENOENT') { add({ id: 'G-A-00', name: 'lint', level: 'intake', must: true, status: 'blocked', severity: 'high', detail: 'ModelSim/iverilog 均不可用' }); return; }
    const out = `${iv.stdout || ''}${iv.stderr || ''}`.trim();
    add({ id: 'G-A-00', name: 'iverilog lint(回退)', level: 'intake', must: true, status: iv.status === 0 ? 'pass' : 'fail', severity: 'high', detail: iv.status === 0 ? '编译干净 exit 0' : out.split('\n').slice(0, 20) });
  })();

  // G-A-02 命名 (clk/rst + 端口前缀, AXI 豁免)
  (() => {
    const v = [];
    if (!/^i_clk/.test(manifest.clock.name)) v.push(`时钟 '${manifest.clock.name}' 应为 i_clk* (红线/命名)`);
    if (!/^i_rst/.test(manifest.reset.name)) v.push(`复位 '${manifest.reset.name}' 应为 i_rst*`);
    for (const port of manifest.ports) {
      const nm = port.name;
      if (nm === manifest.clock.name || nm === manifest.reset.name) continue;
      if (port.bus || BUS_RE.test(nm)) continue; // 协议豁免
      if (port.direction === 'input' && !/^i_/.test(nm)) v.push(`输入端口 '${nm}' 缺 i_ 前缀`);
      if (port.direction === 'output' && !/^o_/.test(nm)) v.push(`输出端口 '${nm}' 缺 o_ 前缀`);
    }
    add({ id: 'G-A-02', name: '命名规范', level: 'intake', must: true, status: v.length ? 'fail' : 'pass', severity: 'high', detail: v.length ? v : '命名合规 (AXI 豁免已计)' });
  })();

  // G-A-01 复位红线 (源 rules/01-hdl §红线3)
  (() => {
    const v = [];
    if (manifest.reset.polarity === 'active_low') v.push('复位为 active_low → 违红线3(须高有效)');
    if (manifest.reset.type === 'async' && !manifest.reset.async_release_synchronized) v.push('异步复位且无"异步复位同步释放"证据 → 违红线3');
    const m = code.match(/negedge\s+(\w+)/);
    if (m) v.push(`RTL 出现 async 边沿 'negedge ${m[1]}' (确认异步复位)`);
    add({ id: 'G-A-01', name: '复位红线', level: 'qualification', must: true, status: v.length ? 'fail' : 'pass', severity: 'high', detail: v.length ? v : '同步高有效复位' });
  })();

  // REDLINE-2 输出寄存 (组合直出检测)
  (() => {
    const combLHS = new Set();
    const combRe = /always_comb\b([\s\S]*?)(?=\n\s*(?:always|assign|endmodule)\b)/g; let mm;
    while ((mm = combRe.exec(code))) { let a; const asg = /(\w+)\s*(?:\[[^\]]*\])?\s*=(?![=])/g; while ((a = asg.exec(mm[1]))) combLHS.add(a[1]); }
    const outPorts = manifest.ports.filter((p) => p.direction === 'output').map((p) => p.name);
    const v = [];
    const asgRe = /assign\s+(\w+)\s*=\s*([^;]+);/g; let am;
    while ((am = asgRe.exec(code))) {
      const [, lhs, rhs] = am;
      if (!outPorts.includes(lhs)) continue;
      const drivenByComb = [...combLHS].some((n) => new RegExp(`\\b${n}\\b`).test(rhs));
      if (drivenByComb) v.push(`输出 '${lhs}' 由组合信号驱动 (assign ← always_comb) → 违红线2(须 ro_ 寄存)`);
    }
    for (const p of outPorts) if (combLHS.has(p)) v.push(`输出 '${p}' 直接在 always_comb 赋值 → 违红线2`);
    add({ id: 'RL-OUT', name: '输出寄存(红线2)', level: 'qualification', must: true, status: v.length ? 'fail' : 'pass', severity: 'high', detail: v.length ? v : '输出均由寄存/常量驱动' });
  })();

  // G-C-03 / CS-6 综合源禁 initial
  (() => {
    const n = (code.match(/\binitial\b/g) || []).length;
    add({ id: 'G-C-03', name: '综合源禁 initial', level: 'qualification', must: true, status: n ? 'fail' : 'pass', severity: 'high', detail: n ? `发现 ${n} 处 initial (仿真-综合差异源; ROM 用 {default:..} 或外部 $readmemh)` : '无 initial' });
  })();

  // G-A-04 / CS-7 尺寸
  (() => {
    const v = [];
    for (const s of rtlSrcs) {
      const abs = path.join(pkgDir, s.path); if (!fs.existsSync(abs)) continue;
      const raw = fs.readFileSync(abs, 'utf8'); const nl = raw.split('\n').length;
      if (nl > 300) v.push(`${s.path}: ${nl} 行 > 300 (白名单类走 size_metrics.waivers)`);
      for (const b of alwaysBlocks(stripComments(raw))) if (b.len > 50) v.push(`${s.path}:${b.start} always 块 ${b.len} 行 > 50`);
    }
    add({ id: 'G-A-04', name: '尺寸上限', level: 'qualification', must: true, status: v.length ? 'fail' : 'pass', severity: 'mid', detail: v.length ? v : '模块≤300 行/always≤50 行' });
  })();

  // G-DOC-01 README + 模块头
  (() => {
    const v = [];
    if (!fs.existsSync(path.join(pkgDir, 'README.md'))) v.push('缺 README.md');
    const first = rtlText.slice(0, rtlText.search(/\bmodule\b/) >= 0 ? rtlText.search(/\bmodule\b/) : 400);
    const headerLines = (first.match(/^\s*\/\/.*$/gm) || []).length;
    if (headerLines < 3) v.push('模块头注释块 <3 行 (须含 名称/功能/端口/主要逻辑)');
    add({ id: 'G-DOC-01', name: 'README+模块头', level: 'intake', must: true, status: v.length ? 'fail' : 'pass', severity: 'warning', detail: v.length ? v : 'README + 模块头齐备' });
  })();

  // G-B-01 需求/文档锚链解析
  (() => {
    const v = [];
    const resolve = (ref) => {
      if (!ref) return false;
      if (!/[\/\\]|\.md$/.test(ref)) return true; // 非路径 id, 视为已声明
      return fs.existsSync(path.resolve(repoRoot, ref)) || fs.existsSync(path.join(pkgDir, ref));
    };
    if (!manifest.requirement_ref) v.push('requirement_ref 为空');
    else if (!resolve(manifest.requirement_ref)) v.push(`requirement_ref 断链: ${manifest.requirement_ref}`);
    (manifest.doc_refs || []).forEach((d) => { if (!resolve(d)) v.push(`doc_ref 断链: ${d}`); });
    add({ id: 'G-B-01', name: '需求/文档锚绑定', level: 'intake', must: true, status: v.length ? 'fail' : 'pass', severity: 'mid', detail: v.length ? v : '锚链起点已连' });
  })();

  // G-B-02 golden 锚解析到受治理资产
  (() => {
    const ref = manifest.golden_model_ref;
    let found = false;
    if (ref) {
      const roots = [path.join(repoRoot, 'engineering-assets', 'models'), path.join(repoRoot, 'engineering-assets', 'cbb'), path.join(repoRoot, 'engineering-assets', 'incubator')];
      for (const r of roots) if (fs.existsSync(r)) {
        const stack = [r];
        while (stack.length) { const d = stack.pop(); for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) stack.push(fp);
          else if (e.name === 'manifest.json') { try { if (JSON.parse(fs.readFileSync(fp, 'utf8')).asset_uid === ref) found = true; } catch {} }
        } }
      }
    }
    add({ id: 'G-B-02', name: 'golden 正确性锚', level: 'qualification', must: true, status: !ref ? 'fail' : found ? 'pass' : 'blocked', severity: 'high', detail: !ref ? 'golden_model_ref 为空' : found ? `已解析到受治理 golden 资产 ${ref}` : `golden 资产 ${ref} 尚未纳入库治理 (model 域待迁移)` });
  })();

  // G-B-03 bit-true 对标 — 读 ModelSim cosim 证据 (tb 场景5 写入 alignment-report.json)
  (() => {
    const rpt = path.join(repoRoot, 'engineering-assets', 'var', 'gates', 'pg', manifest.asset_uid || 'x', 'alignment-report.json');
    if (!fs.existsSync(rpt)) { add({ id: 'G-B-03', name: 'bit-true 对标', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: '无 cosim 证据 (先跑 vsim -c -do run.do 生成 alignment-report.json)' }); return; }
    let r;
    try { r = JSON.parse(fs.readFileSync(rpt, 'utf8')); } catch { add({ id: 'G-B-03', name: 'bit-true 对标', level: 'certified', must: true, status: 'fail', severity: 'high', detail: 'alignment-report.json 非法 JSON' }); return; }
    const ok = r.bit_true === true && r.mismatch === 0 && r.total >= 2048;
    const claimsBitTrue = (manifest.fidelity || {}).status === 'bit_true';
    // 声明 bit_true 却有 mismatch => FAIL (规范 §2.6 G-B-03)
    add({ id: 'G-B-03', name: 'bit-true 对标', level: 'certified', must: true, status: ok ? 'pass' : 'fail', severity: 'high', detail: ok ? `bit-true: ${r.total} 样点 0 失配 (流水偏移 ${r.pipeline_offset}) [${r.tool}]` : `mismatch=${r.mismatch}/${r.total}${claimsBitTrue ? ' — 声明 bit_true 却有失配, FAIL' : ''}` });
  })();
  add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: 'Vivado STA 未接线' });
  add({ id: 'G-C-02', name: '资源在包络内', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: 'Vivado synth util 未接线' });
  add({ id: 'G-SIGN-01', name: '具名签字+面板', level: 'certified', must: true, status: manifest.signoff ? 'pass' : 'blocked', severity: 'high', detail: manifest.signoff ? `signoff.by=${manifest.signoff.by}` : '无 signoff (认证前置)' });

  return gates;
}

// ── 主流程 ───────────────────────────────────────────────────────────────
const LEVEL_ORDER = ['reference', 'intake', 'qualification', 'certified'];
function main() {
  const args = process.argv.slice(2);
  const pkgDir = args[0];
  const rrIdx = args.indexOf('--repo-root');
  const repoRoot = rrIdx >= 0 ? path.resolve(args[rrIdx + 1]) : process.cwd();
  if (!pkgDir) { console.error('用法: node gate-runner.cjs <asset-package-dir> [--repo-root <dir>]'); process.exit(2); }
  const manifestPath = path.join(pkgDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.error(`缺 ${manifestPath}`); process.exit(2); }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { console.error(`manifest.json 非法 JSON: ${e.message}`); process.exit(2); }

  const gates = [];
  // CS-1 schema 校验
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'engineering-assets', 'schemas', 'cbb-manifest.schema.json'), 'utf8'));
  const schemaErrs = validate(schema, manifest);
  gates.push({ id: 'CS-1', name: 'manifest schema', level: 'intake', must: true, status: schemaErrs.length ? 'fail' : 'pass', severity: 'high', detail: schemaErrs.length ? schemaErrs : 'schema 校验通过' });
  if (!schemaErrs.length) gates.push(...runGates(pkgDir, manifest, repoRoot));

  // 证据落盘
  const uid = manifest.asset_uid || 'unknown';
  const evDir = path.join(repoRoot, 'engineering-assets', 'var', 'gates', 'pg', uid);
  fs.mkdirSync(evDir, { recursive: true });
  for (const g of gates) fs.writeFileSync(path.join(evDir, `${g.id}.json`), JSON.stringify(g, null, 2));

  // 判定达到的成熟度级
  const mustByLevel = (lvl) => gates.filter((g) => g.must && g.level === lvl);
  let cleared = 'reference';
  for (const lvl of ['intake', 'qualification', 'certified']) {
    const blockers = mustByLevel(lvl).filter((g) => g.status !== 'pass' && g.status !== 'na');
    if (blockers.length) break;
    cleared = lvl;
  }
  const firstBlockedLevel = LEVEL_ORDER[LEVEL_ORDER.indexOf(cleared) + 1];
  const blockers = firstBlockedLevel ? mustByLevel(firstBlockedLevel).filter((g) => g.status !== 'pass' && g.status !== 'na') : [];

  const summary = { asset_uid: uid, name: manifest.name, declared_level: manifest.maturity.level, cleared_level: cleared, blocking_at: firstBlockedLevel || null, gate_count: gates.length, generated_by: 'gate-runner.cjs MVP', gates: gates.map((g) => ({ id: g.id, level: g.level, must: g.must, status: g.status, severity: g.severity })) };
  fs.writeFileSync(path.join(evDir, 'gate-results.json'), JSON.stringify(summary, null, 2));

  // 打印
  const icon = { pass: '✅', fail: '❌', blocked: '⛔', na: '➖' };
  console.log(`\n资产: ${uid}  (${manifest.name})  声明级=${manifest.maturity.level}`);
  console.log('─'.repeat(78));
  console.log('门 ID       级别           MUST 状态    说明');
  console.log('─'.repeat(78));
  for (const g of gates) {
    const d = Array.isArray(g.detail) ? g.detail[0] + (g.detail.length > 1 ? ` (+${g.detail.length - 1})` : '') : g.detail;
    console.log(`${g.id.padEnd(10)} ${g.level.padEnd(13)} ${(g.must ? 'M' : '·').padEnd(4)} ${icon[g.status] || g.status}  ${String(d).slice(0, 42)}`);
  }
  console.log('─'.repeat(78));
  console.log(`达到级别: ${cleared.toUpperCase()}` + (firstBlockedLevel ? `  (卡在 ${firstBlockedLevel}, ${blockers.length} 个 MUST 门未过)` : '  ✅ 满足 certified 资格'));
  if (blockers.length) console.log(`阻塞门: ${blockers.map((b) => b.id).join(', ')}`);
  console.log(`证据: ${path.relative(repoRoot, evDir)}/`);
  process.exit(cleared === 'certified' ? 0 : 1);
}
main();
