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
  if (schema.const !== undefined && JSON.stringify(data) !== JSON.stringify(schema.const)) {
    errs.push(`${p}: 值 ${JSON.stringify(data)} != const ${JSON.stringify(schema.const)}`);
  }
  // allOf / if-then-else: 支撑 required 按 maturity.level 条件化（规范 §3.1）
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) validate(sub, data, p, errs);
  if (schema.if) {
    const branch = validate(schema.if, data, p, []).length === 0 ? schema.then : schema.else;
    if (branch) validate(branch, data, p, errs);
  }
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
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function redlineChecks(manifest, code) {
  const v = [];
  const reset = manifest.reset || {};
  if (reset.polarity === 'active_low') v.push('复位为 active_low → 违红线3(须高有效)');
  if (reset.type === 'async' && !reset.async_release_synchronized) v.push('异步复位且无"异步复位同步释放"证据 → 违红线3');
  const resetName = reset.name || 'i_rst';
  const resetNegedge = new RegExp(`\\bnegedge\\s+${escapeRegExp(resetName)}\\b`).test(code);
  if (reset.type === 'sync' && resetNegedge) v.push(`RTL 出现 reset async 边沿 'negedge ${resetName}' → manifest 声明为同步复位`);
  if (reset.type === 'async' && resetNegedge) v.push(`RTL 出现 async 边沿 'negedge ${resetName}' (确认异步复位)`);
  return v;
}
// 声明中"标识符后紧跟 [" 者为存储器阵列 (reg [4:0] rom [0:N-1]);
// 而 reg [4:0] foo; 的 [ ] 在标识符之前, 是向量不是阵列。
function memoryArrayNames(code) {
  const names = new Set();
  for (const stmt of code.split(';')) {
    const m = stmt.match(/\b(?:reg|logic|wire|bit)\b(?:\s*signed)?(?:\s*\[[^\]]*\])*([\s\S]*)$/);
    if (!m) continue;
    const am = m[1].match(/^\s*(\w+)\s*\[/);
    if (am) names.add(am[1]);
  }
  return names;
}

// 提取每个 initial 块的块体 (按 begin/end 深度)
function initialBodies(code) {
  const out = []; const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\binitial\b/.test(lines[i])) continue;
    let depth = 0, started = false, j = i; const buf = [];
    for (; j < lines.length; j++) {
      buf.push(lines[j]);
      const opens = (lines[j].match(/\bbegin\b/g) || []).length;
      const closes = (lines[j].match(/\bend\b/g) || []).length;
      depth += opens - closes; if (opens) started = true;
      if (started && depth <= 0) break;
      if (!started && /;/.test(lines[j]) && j > i) break; // 单语句 initial
    }
    out.push({ line: i + 1, body: buf.join('\n') });
  }
  return out;
}

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
  const engineRoot = fs.existsSync(path.join(repoRoot, 'var')) ? repoRoot : path.join(repoRoot, 'engineering-assets');
  const waiverPath = fs.existsSync(path.join(engineRoot, 'var', 'cbb', 'waiver-ledger.json'))
    ? path.join(engineRoot, 'var', 'cbb', 'waiver-ledger.json')
    : path.join(engineRoot, 'catalog', 'waiver-ledger.json');
  let waiverEntries = [];
  try { waiverEntries = JSON.parse(fs.readFileSync(waiverPath, 'utf8')).entries || []; } catch {}
  const DENY_GATES = new Set(['G-A-00', 'G-A-01', 'G-A-02', 'RL-OUT', 'G-C-03', 'G-B-03', 'G-B-05']);
  const add = (g) => {
    const waiver = waiverEntries.find((entry) => entry.asset_uid === manifest.asset_uid && entry.gate === g.id && entry.status === 'open' && !DENY_GATES.has(g.id) && (!entry.expires_at || Date.parse(entry.expires_at) >= Date.now()));
    if (waiver && ['fail', 'blocked'].includes(g.status)) gates.push({ ...g, status: 'waived', waiver_id: waiver.id, detail: `${g.detail}; waived by ${waiver.id} within scope` });
    else gates.push(g);
  };
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
      // 源身份按 **LF 归一内容** 判定, 不按检出字节。
      // 理由: git 在 Windows 检出为 CRLF、Linux 为 LF, 同一 commit 的同一文件
      // 原始字节哈希随平台而变 —— 按原始字节比对会让 CS-2 在 Windows 上整体误报。
      // 归一只吸收行结束符差异, 不掩盖任何实质内容改动。
      const buf = fs.readFileSync(abs);
      const actual = sha256(buf);
      const normalized = sha256(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
      if (actual !== s.sha256 && normalized !== s.sha256) {
        bad.push(`${s.path}: sha256 不符 (声明 ${s.sha256.slice(0, 12)}… 实为 ${actual.slice(0, 12)}… / LF 归一 ${normalized.slice(0, 12)}…)`);
      }
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
    const defaultNettypeNone = path.join(repoRoot, 'engineering-assets', 'tools', 'lib', 'default_nettype_none.vh');
    const defaultNettypeWire = path.join(repoRoot, 'engineering-assets', 'tools', 'lib', 'default_nettype_wire.vh');
    const compileSources = [defaultNettypeNone, ...rtlAbs, defaultNettypeWire];
    try { fs.rmSync(build, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(build, { recursive: true });
    const vlib = cp.spawnSync('vlib', ['work'], { cwd: build, encoding: 'utf8' });
    if (!(vlib.error && vlib.error.code === 'ENOENT')) {
      const vlog = cp.spawnSync('vlog', ['-sv', '-quiet', '-work', 'work', ...compileSources.map((f) => path.resolve(f))], { cwd: build, encoding: 'utf8' });
      const out = `${vlog.stdout || ''}${vlog.stderr || ''}`;
      const mm = out.match(/Errors:\s*(\d+),\s*Warnings:\s*(\d+)/);
      const errs = mm ? parseInt(mm[1], 10) : (vlog.status === 0 ? 0 : 1);
      const warns = mm ? parseInt(mm[2], 10) : 0;
      const implicitNets = out.split(/\r?\n/).filter((line) => /implicit|net.*not declared|not declared.*net/i.test(line));
      add({ id: 'G-A-00', name: 'ModelSim vlog lint', level: 'intake', must: true, status: errs === 0 && implicitNets.length === 0 ? 'pass' : 'fail', severity: 'high', ...(implicitNets.length ? { implicit_nets: implicitNets.length } : {}), detail: errs === 0 && implicitNets.length === 0 ? `vlog 编译干净 (Errors:0 Warnings:${warns})` : [...out.split('\n').filter((l) => /error/i.test(l)).slice(0, 12), ...implicitNets.slice(0, 12)] });
      return;
    }
    const iv = cp.spawnSync('iverilog', ['-g2012', '-t', 'null', ...compileSources], { encoding: 'utf8' });
    if (iv.error && iv.error.code === 'ENOENT') { add({ id: 'G-A-00', name: 'lint', level: 'intake', must: true, status: 'blocked', severity: 'high', detail: 'ModelSim/iverilog 均不可用' }); return; }
    const out = `${iv.stdout || ''}${iv.stderr || ''}`.trim();
    const implicitNets = out.split(/\r?\n/).filter((line) => /implicit|net.*not declared|not declared.*net/i.test(line));
    add({ id: 'G-A-00', name: 'iverilog lint(回退)', level: 'intake', must: true, status: iv.status === 0 && implicitNets.length === 0 ? 'pass' : 'fail', severity: 'high', ...(implicitNets.length ? { implicit_nets: implicitNets.length } : {}), detail: iv.status === 0 && implicitNets.length === 0 ? '编译干净 exit 0; implicit_nets=0' : [...out.split('\n').slice(0, 20), ...implicitNets.slice(0, 12)] });
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
    const v = redlineChecks(manifest, code);
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

  // G-C-03 / CS-6 综合源 initial —— 按判据精化 (规范 §2.7):
  // 本门要防的是"仿真-综合差异": 综合器忽略 initial 而仿真执行它, 导致上板行为不同。
  // 给触发器/向量寄存器赋初值属此类 -> fail。
  // 而只对**存储器阵列**赋值的 initial 是 ROM/RAM 推断的标准可综合写法
  // (Xilinx 即以此推断 BRAM/LUTROM 的初值), 不构成差异源 -> 不判 fail,
  // 但仍需综合报告证实, 故标 blocked 而非 pass —— 与本 runner
  // "tool 类门未接线标 blocked, 绝不静默放行" 的原则一致。
  (() => {
    const blocks = initialBodies(code);
    if (!blocks.length) {
      add({ id: 'G-C-03', name: '综合源禁 initial', level: 'qualification', must: true, status: 'pass', severity: 'high', detail: '无 initial' });
      return;
    }
    const arrays = memoryArrayNames(code);
    const scalarHits = [];
    let arrayOnly = 0;
    for (const b of blocks) {
      const lhs = new Set();
      const re = /(\w+)\s*(?:\[[^\]]*\])*\s*(?:<=|=)(?![=])/g;
      let m;
      while ((m = re.exec(b.body))) lhs.add(m[1]);
      // 循环控制变量不是被初始化的存储元件
      for (const v of ['i', 'ri', 'br', 'bc', 'ci', 'init_i', 'j', 'k']) lhs.delete(v);
      const bad = [...lhs].filter((n) => !arrays.has(n));
      if (bad.length) scalarHits.push(`initial@${b.line}: 对非阵列对象赋初值 ${bad.slice(0, 4).join(',')}`);
      else arrayOnly++;
    }
    if (scalarHits.length) {
      add({ id: 'G-C-03', name: '综合源禁 initial', level: 'qualification', must: true, status: 'fail', severity: 'high', detail: scalarHits });
      return;
    }
    // 仅阵列初始化: 由 Vivado synth 日志裁决 —— 综合器是否真的采纳了这些初值。
    // [Synth 8-6896] 明示 initial 块被整体忽略 => 仿真-综合差异确凿, FAIL。
    // [Synth 8-3848] 网络无驱动源, 作为后果佐证一并列出。
    const synthLog = path.join(repoRoot, 'engineering-assets', 'var', 'gates', 'pg', manifest.asset_uid || 'x', 'synth.log');
    if (!fs.existsSync(synthLog)) {
      add({ id: 'G-C-03', name: '综合源 initial(仅阵列)', level: 'qualification', must: true, status: 'blocked', severity: 'high', detail: `${arrayOnly} 处 initial 仅初始化存储器阵列(ROM 推断写法), 非仿真-综合差异源; 待 Vivado synth 报告证实后转 pass (缺 synth.log)` });
      return;
    }
    const lines = fs.readFileSync(synthLog, 'utf8').split(/\r?\n/);
    const ignored = new Map();
    const nodriver = new Map();
    for (const l of lines) {
      if (l.includes('Synth 8-6896')) {
        const loc = (l.match(/\[([^\]\s]+\.(?:v|sv)):(\d+)\]/) || []).slice(1).join(':');
        ignored.set(loc || '?', (ignored.get(loc || '?') || 0) + 1);
      } else if (l.includes('Synth 8-3848')) {
        const net = (l.match(/Net\s+(\S+)/) || [])[1];
        if (net) nodriver.set(net.replace(/\[\d+\]\[\d+\]$/, '[*][*]'), (nodriver.get(net.replace(/\[\d+\]\[\d+\]$/, '[*][*]')) || 0) + 1);
      }
    }
    if (ignored.size) {
      const where = [...ignored.entries()].map(([loc, n]) => `${loc} (${n}×)`);
      const conseq = [...nodriver.entries()].slice(0, 3).map(([n, c]) => `${n} 无驱动 (${c}×)`);
      add({
        id: 'G-C-03', name: '综合源 initial 被综合器忽略', level: 'qualification', must: true,
        status: 'fail', severity: 'high',
        detail: [`Vivado [Synth 8-6896] 判定 initial 块被忽略: ${where.join('; ')}`, ...(conseq.length ? [`后果: ${conseq.join('; ')}`] : []), '仿真执行而综合丢弃 => 上板行为与仿真不一致'],
      });
      return;
    }
    add({ id: 'G-C-03', name: '综合源 initial(仅阵列)', level: 'qualification', must: true, status: 'pass', severity: 'high', detail: `${arrayOnly} 处 initial 仅初始化存储器阵列, Vivado 综合日志无 [Synth 8-6896] 忽略告警 — 初值被综合器采纳` });
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

  // G-DOC-03 CHANGELOG and G-DOC-04 limitations are lifecycle gates, not prose-only claims.
  (() => {
    const changelog = path.join(pkgDir, 'CHANGELOG.md');
    const readme = path.join(pkgDir, 'README.md');
    const v = [];
    if (!fs.existsSync(changelog) || !fs.readFileSync(changelog, 'utf8').trim()) v.push('CHANGELOG.md missing or empty');
    add({ id: 'G-DOC-03', name: 'CHANGELOG lifecycle', level: 'qualification', must: true, status: v.length ? 'fail' : 'pass', severity: 'mid', detail: v.length ? v : 'CHANGELOG.md present' });
    const docs = [readme, path.join(pkgDir, 'docs', 'limitations.md'), path.join(pkgDir, 'docs', 'LIMITATIONS.md')].filter((file) => fs.existsSync(file));
    const limitationText = docs.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const missing = docs.length === 0 || !/(limitation|known issue|限制|已知问题|边界)/i.test(limitationText);
    add({ id: 'G-DOC-04', name: 'limitations and boundaries', level: 'qualification', must: true, status: missing ? 'fail' : 'pass', severity: 'mid', detail: missing ? 'README/docs must state limitations and verification boundaries' : `limitations documented in ${docs.map((file) => path.relative(pkgDir, file)).join(', ')}` });
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

  // G-B-04 协议锚点声明 — 需求↔资产的版本匹配依据 (owner 裁定 2026-08-02)。
  //   缺字段与"协议中立"是两回事: 中立必须显式声明 standard=none, 未声明判 fail。
  //   跨版资产合法 (11n LDPC 挂在 11a 基线链路上是已裁定的演示闭环), 但必须自己
  //   声明 cross_version —— 声明值与按 catalog/protocol-baseline.json 实算值不符
  //   即静默版本漂移, 判 fail。这正是本门要拦的那类失效: 库内 11a 前端 + 11n LDPC
  //   混版此前无处可查。
  (() => {
    if (manifest.kind === 'golden-model') return;              // golden 锚算法不锚协议版次
    if ((manifest.maturity || {}).level === 'reference') return; // vendored 归档不做协议声明
    const pa = manifest.protocol_anchor;
    if (!pa) {
      add({ id: 'G-B-04', name: '协议锚点声明', level: 'intake', must: true, status: 'fail', severity: 'mid', detail: 'protocol_anchor 缺失 — 协议中立资产也须显式声明 (standard=none / baseline_relation=neutral)' });
      return;
    }
    const v = [];
    const std = typeof pa.standard === 'string' ? pa.standard.trim() : '';
    const rel = pa.baseline_relation;
    const neutral = std.toLowerCase() === 'none';
    if (!std) v.push('protocol_anchor.standard 为空');
    if (neutral) {
      if (rel !== 'neutral') v.push(`standard=none 但 baseline_relation=${rel} (应为 neutral)`);
      for (const k of ['clause', 'sections', 'parameters', 'deviations']) {
        if (pa[k] !== undefined) v.push(`协议中立资产不应声明 ${k} — 中立与"锚在某版某段"自相矛盾`);
      }
    } else if (std) {
      if (!['baseline', 'cross_version'].includes(rel)) v.push(`standard=${std} 但 baseline_relation=${rel} (应为 baseline 或 cross_version)`);
      if (!pa.profile) v.push('非中立锚缺 profile');
      if (!pa.scope) v.push('非中立锚缺 scope — 不写覆盖范围, 标准名会被过度解读');
      if (!pa.anchor_basis) v.push('非中立锚缺 anchor_basis — 锚点如何确证必须可查');
      if (!pa.parameters || Object.keys(pa.parameters).length === 0) v.push('非中立锚缺 parameters — 机械匹配依据不能只有人读 profile');
      // 基线文件按多候选解析: engineRoot 的启发式在 --repo-root 指向 ~/.claude
      // (该处也有 var/) 时会指偏, 而 pkgDir 恒为 <engineering-assets>/cbb/<uid>,
      // 故以包目录上溯两级为准, 其余候选兜底。
      let baseline = null;
      const blCandidates = [
        path.resolve(pkgDir, '..', '..', 'catalog', 'protocol-baseline.json'),
        path.join(engineRoot, 'catalog', 'protocol-baseline.json'),
        path.join(repoRoot, 'engineering-assets', 'catalog', 'protocol-baseline.json'),
      ];
      for (const blPath of blCandidates) {
        try { baseline = JSON.parse(fs.readFileSync(blPath, 'utf8')).baseline; if (baseline) break; } catch {}
      }
      if (!baseline || !baseline.standard) {
        v.push('catalog/protocol-baseline.json 缺失或非法 — 无基线则无从判定跨版 (fail-closed)');
      } else {
        const clauseSame = !pa.clause || !baseline.clause || pa.clause === baseline.clause;
        const computed = (std === baseline.standard && clauseSame) ? 'baseline' : 'cross_version';
        if (rel !== computed) v.push(`baseline_relation 声明 ${rel}, 按基线 (${baseline.standard}${baseline.clause ? ' Clause ' + baseline.clause : ''}) 实算为 ${computed}`);
        if (computed === 'cross_version' && !String(pa.notes || '').trim()) v.push('跨版资产须在 notes 说明为何与基线不同版');
      }
    }
    for (const d of pa.deviations || []) {
      const ref = d && d.ref;
      if (ref && /[\/\\]|\.md$/.test(ref) && !fs.existsSync(path.resolve(repoRoot, ref)) && !fs.existsSync(path.join(pkgDir, ref))) {
        v.push(`偏差 ${d.id} 出处断链: ${ref}`);
      }
    }
    const devN = (pa.deviations || []).length;
    add({
      id: 'G-B-04', name: '协议锚点声明', level: 'intake', must: true,
      status: v.length ? 'fail' : 'pass', severity: 'mid',
      detail: v.length ? v : (neutral
        ? '协议中立 (显式声明, 非缺省)'
        : `${std}${pa.clause ? ' Clause ' + pa.clause : ''} / ${pa.profile} [${rel}]${devN ? `; 已登记偏差 ${devN} 项` : '; 无已登记偏差'}`),
    });
  })();

  // G-B-02 正确性锚 — 按资产类分锚 (owner 裁决 2026-07-27, 决策⑦; 272899f 曾误删):
  //   算法资产 (kind 缺省/rtl): 锚 = golden model, golden_model_ref 必须解析;
  //   结构原语 (kind=primitive): golden 锚的是算法, 不是所有模块 —— 原语的
  //   正确性锚 = 包内自检 TB (含反假绿约定), 不要求 golden_model_ref。
  (() => {
    if (manifest.kind === 'primitive') {
      const tbSrcs = (manifest.sources || []).filter((s) => s.role === 'tb');
      const tbExists = tbSrcs.length > 0
        && tbSrcs.every((s) => fs.existsSync(path.join(pkgDir, s.path)));
      add({
        id: 'G-B-02', name: '正确性锚 (原语=自检 TB)', level: 'qualification', must: true,
        status: tbExists ? 'pass' : 'fail', severity: 'high',
        detail: tbExists
          ? `结构原语正确性锚 = 自检 TB (${tbSrcs.map((s) => s.path).join(', ')}); golden 豁免 (owner 裁决 2026-07-27)`
          : 'kind=primitive 但 sources 中无可解析的 tb 角色文件 — 原语的正确性锚缺失',
      });
      return;
    }
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
  // 结构原语 (kind=primitive) 无 golden 可对标: 本门重定义为"自检 TB 实跑
  // PASS 证据" (tb-selfcheck.json: {pass:true, compares>=1, tool}), 由 TB 或
  // 运行脚本写入证据目录。(决策⑦; 272899f 曾误删本分支)
  (() => {
    if (manifest.kind === 'primitive') {
      const rpt = path.join(repoRoot, 'engineering-assets', 'var', 'gates', 'pg', manifest.asset_uid || 'x', 'tb-selfcheck.json');
      if (!fs.existsSync(rpt)) { add({ id: 'G-B-03', name: '自检 TB 实跑证据 (原语)', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: '无 tb-selfcheck.json — 原语的 bit-true 门 = 自检 TB 实跑 PASS 证据落盘' }); return; }
      let r;
      try { r = JSON.parse(fs.readFileSync(rpt, 'utf8')); } catch { add({ id: 'G-B-03', name: '自检 TB 实跑证据 (原语)', level: 'certified', must: true, status: 'fail', severity: 'high', detail: 'tb-selfcheck.json 非法 JSON' }); return; }
      const ok = r.pass === true && Number(r.compares) >= 1;
      add({ id: 'G-B-03', name: '自检 TB 实跑证据 (原语)', level: 'certified', must: true, status: ok ? 'pass' : 'fail', severity: 'high', detail: ok ? `自检 TB PASS: ${r.compares} 次比对 [${r.tool || 'unknown'}]` : `tb-selfcheck 证据不合格: pass=${r.pass} compares=${r.compares}` });
      return;
    }
    const rpt = path.join(repoRoot, 'engineering-assets', 'var', 'gates', 'pg', manifest.asset_uid || 'x', 'alignment-report.json');
    if (!fs.existsSync(rpt)) { add({ id: 'G-B-03', name: 'bit-true 对标', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: '无 cosim 证据 (先跑 vsim -c -do run.do 生成 alignment-report.json)' }); return; }
    let r;
    try { r = JSON.parse(fs.readFileSync(rpt, 'utf8')); } catch { add({ id: 'G-B-03', name: 'bit-true 对标', level: 'certified', must: true, status: 'fail', severity: 'high', detail: 'alignment-report.json 非法 JSON' }); return; }
    const ok = r.bit_true === true && r.mismatch === 0 && r.total >= 2048;
    const claimsBitTrue = (manifest.fidelity || {}).status === 'bit_true';
    // 声明 bit_true 却有 mismatch => FAIL (规范 §2.6 G-B-03)
    add({ id: 'G-B-03', name: 'bit-true 对标', level: 'certified', must: true, status: ok ? 'pass' : 'fail', severity: 'high', detail: ok ? `bit-true: ${r.total} 样点 0 失配 (流水偏移 ${r.pipeline_offset}) [${r.tool}]` : `mismatch=${r.mismatch}/${r.total}${claimsBitTrue ? ' — 声明 bit_true 却有失配, FAIL' : ''}` });
  })();
  // G-C-01 / G-C-02 — Vivado synth 证据接线 (规范 §2.7)
  // 证据目录: engineering-assets/var/gates/pg/<asset_uid>/
  //   timing-summary.rpt / utilization.rpt  由 tools/pg-synth.tcl 生成
  // 两门共同产出 envelope-check.json (constrained vs required / budget vs achieved)
  (() => {
    const pgDir = path.join(repoRoot, 'engineering-assets', 'var', 'gates', 'pg', manifest.asset_uid || 'x');
    const timingRpt = path.join(pgDir, 'timing-summary.rpt');
    const utilRpt = path.join(pgDir, 'utilization.rpt');
    const target = (manifest.constraints || {}).target || {};
    const envelope = { asset_uid: manifest.asset_uid, generated_by: 'gate-runner.cjs', timing: null, resources: null };

    // ── G-C-01 紧时钟交叉核对 ──────────────────────────────────────────
    (() => {
      const fmaxMhz = Number(target.fmax_mhz);
      if (!Number.isFinite(fmaxMhz) || fmaxMhz <= 0) {
        add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'fail', severity: 'high', detail: 'constraints.target.fmax_mhz 未声明 — 无目标则无从判定收敛' });
        return;
      }
      const requiredPeriod = 1000 / fmaxMhz;
      const clkName = ((manifest.clock || {}).name || '').trim();

      // 约束文件: manifest sources role=constraint, 否则扫包内 *.xdc/*.sdc
      const cfiles = (manifest.sources || []).filter((s) => s.role === 'constraint').map((s) => path.join(pkgDir, s.path))
        .filter((p) => fs.existsSync(p));
      if (!cfiles.length) {
        for (const d of ['constraints', '.']) {
          const dir = path.join(pkgDir, d);
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir)) if (/\.(xdc|sdc)$/i.test(f)) cfiles.push(path.join(dir, f));
        }
      }
      if (!cfiles.length) {
        add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'fail', severity: 'high', detail: `无 XDC/SDC 约束文件 — 约束缺失即 FAIL (目标 ${fmaxMhz}MHz / ${requiredPeriod.toFixed(3)}ns)` });
        return;
      }
      // create_clock -name <n> -period <p> [get_ports <port>]
      const clocks = [];
      for (const cf of cfiles) {
        const txt = fs.readFileSync(cf, 'utf8');
        for (const line of txt.split(/\r?\n/)) {
          if (/^\s*#/.test(line) || !/create_clock/.test(line)) continue;
          const per = line.match(/-period\s+([\d.]+)/);
          if (!per) continue;
          const nm = line.match(/-name\s+(\S+)/);
          const pt = line.match(/get_ports\s+\{?\s*([^\s\]}]+)/);
          clocks.push({ file: path.basename(cf), name: (nm ? nm[1] : (pt ? pt[1] : '')).replace(/[{}]/g, ''), port: pt ? pt[1] : '', period_ns: Number(per[1]) });
        }
      }
      if (!clocks.length) {
        add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'fail', severity: 'high', detail: `约束文件存在但无 create_clock — 约束缺失即 FAIL (${cfiles.map((f) => path.basename(f)).join(',')})` });
        return;
      }
      const clk = clocks.find((c) => clkName && (c.name === clkName || c.port === clkName)) || clocks[0];
      envelope.timing = { target_fmax_mhz: fmaxMhz, required_period_ns: Number(requiredPeriod.toFixed(4)), constrained_period_ns: clk.period_ns, clock: clk.name || clk.port, source: clk.file };

      // 约束不得松于目标 (堵"松时钟白 WNS"后门)
      if (clk.period_ns > requiredPeriod + 1e-6) {
        envelope.timing.status = 'fail';
        envelope.timing.reason = 'constraint-looser-than-target';
        add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'fail', severity: 'high', detail: `约束松于目标: create_clock ${clk.period_ns}ns > 目标 ${requiredPeriod.toFixed(3)}ns (${fmaxMhz}MHz)` });
        return;
      }
      if (!fs.existsSync(timingRpt)) {
        envelope.timing.status = 'blocked';
        add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: `约束合规 (${clk.period_ns}ns ≤ ${requiredPeriod.toFixed(3)}ns) 但无 timing-summary.rpt — 先跑 tools/pg-synth.tcl` });
        return;
      }
      const trpt = fs.readFileSync(timingRpt, 'utf8').split(/\r?\n/);
      // Clock Summary: "<name>  {0.000 2.000}   4.000   250.000"
      let rptPeriod = null;
      for (const l of trpt) {
        const m = l.match(/^(\S+)\s+\{[^}]*\}\s+([\d.]+)\s+([\d.]+)\s*$/);
        if (m && (!clk.name || m[1] === clk.name || m[1] === clk.port)) { rptPeriod = Number(m[2]); break; }
      }
      // Intra-Clock Table: "<name>  <WNS> <TNS> <fail> <total> <WHS> ..."
      let wns = null; let whs = null; let failEp = null;
      for (const l of trpt) {
        const m = l.match(/^(\S+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d+)\s+(\d+)\s+(-?\d+\.\d+)/);
        if (m && (!clk.name || m[1] === clk.name || m[1] === clk.port)) { wns = Number(m[2]); failEp = Number(m[4]); whs = Number(m[6]); break; }
      }
      if (wns === null) {
        envelope.timing.status = 'blocked';
        add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: `timing-summary.rpt 中未找到时钟 ${clk.name || clk.port} 的 WNS 行 — 报告格式不符, 拒绝据此判 pass` });
        return;
      }
      // 报告所用周期须与约束一致, 防止拿另一份宽约束的报告顶账
      if (rptPeriod !== null && Math.abs(rptPeriod - clk.period_ns) > 1e-6) {
        envelope.timing.status = 'fail';
        add({ id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true, status: 'fail', severity: 'high', detail: `报告周期 ${rptPeriod}ns 与约束 ${clk.period_ns}ns 不一致 — 证据与约束不匹配` });
        return;
      }
      const achievedFmax = 1000 / (clk.period_ns - wns); // wns<0 时周期变大, fmax 变小
      Object.assign(envelope.timing, { wns_ns: wns, whs_ns: whs, failing_endpoints: failEp, achieved_fmax_mhz: Number(achievedFmax.toFixed(2)), status: wns >= 0 ? 'pass' : 'fail' });
      add({
        id: 'G-C-01', name: '目标 fmax 收敛', level: 'certified', must: true,
        status: wns >= 0 ? 'pass' : 'fail', severity: 'high',
        detail: wns >= 0
          ? `WNS ${wns}ns ≥ 0 @ ${clk.period_ns}ns (目标 ${fmaxMhz}MHz), achieved ≈ ${achievedFmax.toFixed(1)}MHz`
          : `WNS ${wns}ns < 0 @ ${clk.period_ns}ns — 未收敛; achieved ≈ ${achievedFmax.toFixed(1)}MHz vs 目标 ${fmaxMhz}MHz, ${failEp} 个失败端点`,
      });
    })();

    // ── G-C-02 资源包络 fail-closed ────────────────────────────────────
    (() => {
      const KEYS = [
        { k: 'lut', rpt: 'Slice LUTs' },
        { k: 'ff', rpt: 'Slice Registers' },
        { k: 'bram', rpt: 'Block RAM Tile' },
        { k: 'dsp', rpt: 'DSPs' },
      ];
      const missing = KEYS.filter((e) => !Number.isFinite(Number(target[e.k]))).map((e) => e.k);
      if (missing.length) {
        envelope.resources = { status: 'blocked', missing_budget: missing };
        add({ id: 'G-C-02', name: '资源在包络内', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: `constraints.target 缺资源预算 [${missing.join(', ')}] — 无包络不得认证资源稳定 (fail-closed, 非 pass)` });
        return;
      }
      if (!fs.existsSync(utilRpt)) {
        envelope.resources = { status: 'blocked', reason: 'no-utilization-report' };
        add({ id: 'G-C-02', name: '资源在包络内', level: 'certified', must: true, status: 'blocked', severity: 'high', detail: '预算齐备但无 utilization.rpt — 先跑 tools/pg-synth.tcl' });
        return;
      }
      const urpt = fs.readFileSync(utilRpt, 'utf8').split(/\r?\n/);
      const rows = {};
      for (const l of urpt) {
        const m = l.match(/^\|\s*([A-Za-z0-9 ]+?)\*?\s*\|\s*([\d.]+)\s*\|/);
        if (m && rows[m[1].trim()] === undefined) rows[m[1].trim()] = Number(m[2]);
      }
      const items = KEYS.map((e) => {
        const budget = Number(target[e.k]);
        const achieved = rows[e.rpt];
        return { resource: e.k, budget, achieved: achieved === undefined ? null : achieved, status: achieved === undefined ? 'blocked' : (achieved <= budget ? 'pass' : 'fail') };
      });
      envelope.resources = { status: items.some((i) => i.status === 'fail') ? 'fail' : items.some((i) => i.status === 'blocked') ? 'blocked' : 'pass', items };
      const bad = items.filter((i) => i.status === 'fail');
      const unk = items.filter((i) => i.status === 'blocked');
      add({
        id: 'G-C-02', name: '资源在包络内', level: 'certified', must: true,
        status: envelope.resources.status, severity: 'high',
        detail: bad.length ? `超包络: ${bad.map((i) => `${i.resource} ${i.achieved}>${i.budget}`).join(', ')}`
          : unk.length ? `utilization.rpt 缺行: ${unk.map((i) => i.resource).join(', ')}`
            : `全部在包络内: ${items.map((i) => `${i.resource} ${i.achieved}/${i.budget}`).join(', ')}`,
      });
    })();

    try { fs.mkdirSync(pgDir, { recursive: true }); fs.writeFileSync(path.join(pgDir, 'envelope-check.json'), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8'); } catch {}
  })();
  // G-C-04 / G-C-05 / G-GATE-01 —— 规范 §5 晋级 certified 要求 G-C-01..05 全绿,
  // 但此前 runner 只实现了 G-C-01/02/03, 另两道与证据齐备门**根本没有出现在
  // 结果里**。缺席比 blocked 更危险: 资产看起来"只差签字"就能被推上 certified。
  // 现按 fail-closed 补齐 —— 无证据即 blocked, 绝不静默放行。
  (() => {
    const pgDir = path.join(repoRoot, 'engineering-assets', 'var', 'gates', 'pg', manifest.asset_uid || 'x');
    const has = (rel) => fs.existsSync(path.join(pgDir, rel));

    // CDC 结构扫描 (规范 §2.7: 无 CDC 工具时降级为结构扫描并标 cdc_tool=na,
    // **禁止在无工具时声称 clean**)。单时钟域资产由此得到可复核的报告。
    if (!has('cdc-report.json')) {
      const clocks = new Set();
      for (const m of code.matchAll(/@\s*\(\s*(?:posedge|negedge)\s+([A-Za-z_]\w*)/g)) clocks.add(m[1]);
      const declared = ((manifest.clock || {}).name || '').trim();
      const rpt = {
        id: 'G-C-04.cdc',
        cdc_tool: 'na',
        method: 'structural-scan (gate-runner)',
        note: '无具名 CDC 工具, 按规范降级为结构扫描; 不声称 clean, 仅陈述所扫结果',
        clocks_found: [...clocks],
        declared_clock: declared || null,
        single_clock_domain: clocks.size <= 1,
        cross_clock_paths_detected: clocks.size <= 1 ? 0 : null,
        pass: clocks.size <= 1 && (!declared || clocks.has(declared)),
      };
      try { fs.mkdirSync(pgDir, { recursive: true }); fs.writeFileSync(path.join(pgDir, 'cdc-report.json'), `${JSON.stringify(rpt, null, 2)}\n`, 'utf8'); } catch {}
    }

    // G-C-04 复位/CDC 健壮
    const missing04 = ['reset-sim.json', 'cdc-report.json'].filter((f) => !has(f));
    add({
      id: 'G-C-04', name: '复位/CDC 健壮', level: 'certified', must: true,
      status: missing04.length ? 'blocked' : 'pass', severity: 'high',
      detail: missing04.length
        ? `缺证据 ${missing04.join(', ')} — 需 TB 产出逐寄存器复位比对与 CDC 报告(单时钟域可标 cdc_tool=na 但须出报告)`
        : '复位逐寄存器比对与 CDC 报告齐备',
    });

    // G-C-05 边界/压力/回归 — 四个具名子结果的机器 AND, 不接受聚合散文
    const SUBS = ['boundary', 'stress', 'regression', 'backpressure'];
    const sub = SUBS.map((s) => {
      const rel = path.join('stability', `${s}.json`);
      if (!has(rel)) return { s, status: 'blocked', detail: '缺证据' };
      try {
        const j = JSON.parse(fs.readFileSync(path.join(pgDir, rel), 'utf8'));
        return { s, status: j.pass === true ? 'pass' : 'fail', detail: j.reason || (j.pass === true ? 'pass' : 'fail') };
      } catch { return { s, status: 'fail', detail: '非法 JSON' }; }
    });
    const bad05 = sub.filter((x) => x.status === 'fail');
    const blk05 = sub.filter((x) => x.status === 'blocked');
    add({
      id: 'G-C-05', name: '边界/压力/回归', level: 'certified', must: true,
      status: bad05.length ? 'fail' : blk05.length ? 'blocked' : 'pass', severity: 'high',
      detail: bad05.length ? `子结果失败: ${bad05.map((x) => `${x.s}(${x.detail})`).join(', ')}`
        : blk05.length ? `缺子结果: ${blk05.map((x) => x.s).join(', ')} — 须为 stability/<name>.json 且 pass=true`
          : '四个子结果均 pass',
    });

    // G-GATE-01 证据齐备 — 判 pass 的 tool 类门必须有对应产物文件
    // G-B-03 产物按资产类分锚(决策⑦): 算法资产=alignment-report, 原语=tb-selfcheck
    const REQ = [
      { f: 'timing-summary.rpt', for: 'G-C-01' },
      { f: 'utilization.rpt', for: 'G-C-02' },
      { f: 'envelope-check.json', for: 'G-C-01/02' },
      { f: 'synth.log', for: 'G-C-03' },
      manifest.kind === 'primitive'
        ? { f: 'tb-selfcheck.json', for: 'G-B-03' }
        : { f: 'alignment-report.json', for: 'G-B-03' },
    ];
    const missingEv = REQ.filter((r) => !has(r.f));
    add({
      id: 'G-GATE-01', name: '证据齐备', level: 'certified', must: true,
      status: missingEv.length ? 'blocked' : 'pass', severity: 'high',
      detail: missingEv.length
        ? `缺产物: ${missingEv.map((r) => `${r.f}(${r.for})`).join(', ')}`
        : `${REQ.length} 项证据产物齐备`,
    });

    // G-GATE-02 证据可复现 —— G-GATE-01 只问"证据在不在", 这道门问"能不能重做"
    //
    // 2026-08-02 普查动因: 16 个 certified 里 14 个的证据当时无法被任何人重新生成 ——
    // 8 个原语包只有 tb_*.sv, 那次 xvlog/xelab/xsim 的具体调用从未落盘; 另外 6 个
    // 只有 ModelSim 脚本而本机 ModelSim 已故障, 其中 channel_est_top/run.do 甚至列了
    // 包里根本不存在的 RTL 文件。**这些包全都通过了 G-GATE-01** —— 因为证据文件确实
    // 都在。证据"在"与证据"可重做"是两件事, 只查前者, 洞就会一直被填满。
    //
    // 判据刻意只查两件可机器验证的事, 不试图执行命令:
    //   1) manifest.reproduce.sim 存在 (复现方式必须是**声明出来的契约**, 不是
    //      README 里的散文 —— 散文会漂移, 且无法被门禁看见);
    //   2) 该命令引用的脚本/文件在仓库里真实存在 (直接拦住 incubator/ 那类失效路径,
    //      以及入口被删/改名后无人更新的情况)。
    // 不执行命令: 门禁跑一次完整仿真既慢又会与被判定的证据互相污染; 能否跑通由
    // G-B-03/G-C-04/G-C-05 的实测产物本身承担。
    const repro = (manifest.reproduce && typeof manifest.reproduce === 'object') ? manifest.reproduce : {};
    const reproSim = String(repro.sim || '').trim();
    const SCRIPT_RE = /(?:^|[\s"'=])([A-Za-z0-9_./-]+\.(?:sh|do|tcl|py|m|cjs|js))(?=$|[\s"'])/g;
    const referenced = [];
    let mm;
    while ((mm = SCRIPT_RE.exec(reproSim)) !== null) referenced.push(mm[1]);
    const resolveRepro = (rel) => [
      path.resolve(repoRoot, rel),
      path.resolve(repoRoot, 'engineering-assets', rel),
      path.join(pkgDir, rel),
    ].some((p) => fs.existsSync(p));
    const missingScripts = referenced.filter((r) => !resolveRepro(r));

    let g02status; let g02detail;
    if (!reproSim) {
      g02status = 'blocked';
      g02detail = '缺 manifest.reproduce.sim —— 证据须声明可复现的仿真入口(命令), 否则无人能重做它';
    } else if (!referenced.length) {
      g02status = 'blocked';
      g02detail = `reproduce.sim 未引用任何脚本文件: ${reproSim}`;
    } else if (missingScripts.length) {
      g02status = 'blocked';
      g02detail = `reproduce.sim 引用的入口不存在: ${missingScripts.join(', ')}`;
    } else {
      g02status = 'pass';
      g02detail = `复现入口已声明且存在: ${referenced.join(', ')}`;
    }
    add({
      id: 'G-GATE-02', name: '证据可复现', level: 'certified', must: true,
      status: g02status, severity: 'high', detail: g02detail,
    });
  })();

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
    const blockers = mustByLevel(lvl).filter((g) => !['pass', 'na', 'waived'].includes(g.status));
    if (blockers.length) break;
    cleared = lvl;
  }
  const firstBlockedLevel = LEVEL_ORDER[LEVEL_ORDER.indexOf(cleared) + 1];
  const blockers = firstBlockedLevel ? mustByLevel(firstBlockedLevel).filter((g) => !['pass', 'na', 'waived'].includes(g.status)) : [];

  const summary = { asset_uid: uid, name: manifest.name, declared_level: manifest.maturity.level, cleared_level: cleared, blocking_at: firstBlockedLevel || null, gate_count: gates.length, generated_by: 'gate-runner.cjs v1.1', redline_contract: 'reset-signal-scoped', gates: gates.map((g) => ({ id: g.id, level: g.level, must: g.must, status: g.status, severity: g.severity })) };
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
if (require.main === module) main();

module.exports = { main, redlineChecks, runGates, validate };
