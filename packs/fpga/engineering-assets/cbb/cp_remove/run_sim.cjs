#!/usr/bin/env node
//=============================================================================
// run_sim.cjs — cp_remove 的可复现仿真入口 (G-GATE-02 声明的那个)
//
//   node engineering-assets/cbb/cp_remove/run_sim.cjs            # 只跑
//   node engineering-assets/cbb/cp_remove/run_sim.cjs --install  # 跑 + 落证据
//
// 为什么用 iverilog 而不是 ModelSim: 本机 ModelSim 回环 RPC 自 2026-08-01 起故障
// (见 cbb/ldpc_codec/run_xsim.sh 头注释)。iverilog 是本机可用的回归路径。
//
// **证据只能由实跑结果生成**: 每份 JSON 的 pass 字段都来自 TB 自己打印的判定,
// 本脚本不构造 pass=true。任一 TB 未打出 RESULT: PASS 即整体失败并且**不写**
// 任何证据 —— 半份证据比没有证据更危险。
//=============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG = __dirname;
const REPO = path.resolve(PKG, '..', '..', '..');   // cbb/<uid> -> engineering-assets -> 仓库根
const PG = path.join(REPO, 'engineering-assets', 'var', 'gates', 'pg', 'cp_remove');
const SIM = path.join(PKG, 'sim');
const RTL = path.join(PKG, 'rtl', 'cp_remove.sv');
const install = process.argv.includes('--install');
// --xsim: 换 Vivado xsim 跑**同一批 TB、同一套判据** —— 第二仿真器交叉验证。
// 只换仿真器不换判据才叫交叉验证; 换个跑法凑数不算。
const useXsim = process.argv.includes('--xsim');

const TOOL = useXsim
  ? 'Vivado xsim 2023.1 (xvlog/xelab/xsim)'
  : 'Icarus Verilog (iverilog -g2012 / vvp)';

const XBUILD = path.join(REPO, 'engineering-assets', 'var', 'build', 'xsim-cp_remove');

// xelab 的 -timescale: 本包 RTL 不带 `timescale (综合不需要), 而 TB 带 ——
// xsim 会为默认参数绑定生成 <top>_default 模块并因"设计内时标不一致"报错。
// 显式统一即可; 这是仿真器环境差异, 不是 RTL 缺陷 (iverilog 无此要求)。
// Windows 上 Vivado 的 xvlog/xelab/xsim 可执行体是 .bat (同名无扩展文件是给 bash
// 用的 shell 脚本)。两道坎: 不带 .bat 直接调 -> ENOENT; 带了 .bat 仍 EINVAL ——
// Node 20+ 起不再直接 spawn .bat/.cmd (CVE-2024-27980), 必须经 shell。
const WIN = process.platform === 'win32';
const q = (s) => (WIN ? `"${s}"` : s);

function xrun(name, args, opt) {
  if (WIN) return execFileSync(`${name}.bat`, args.map(q), { ...opt, shell: true });
  return execFileSync(name, args, opt);
}

function runXsim(tbName, srcs) {
  fs.mkdirSync(XBUILD, { recursive: true });
  const opt = { cwd: XBUILD, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  xrun('xvlog', ['--sv', ...srcs], opt);
  xrun('xelab', ['-debug', 'typical', '-timescale', '1ns/1ps', tbName, '-s', `s_${tbName}`], opt);
  return xrun('xsim', [`s_${tbName}`, '-R'], opt);
}

// role: judge = 功能判据; measure = 测量 TB (不产出 pass/fail 判据, 只出数)
const TBS = [
  { name: 'tb_cp_remove',           out: 'tb.vvp',        role: 'judge',   what: '切窗序列/帧尾/侧带/UNSYNC 静默/复位重入' },
  { name: 'tb_cp_remove_cosim',     out: 'tb_cosim.vvp',  role: 'judge',   what: '对治理 golden rx_cp_window 0 容差 2176 点' },
  { name: 'tb_cp_remove_reset',     out: 'tb_reset.vvp',  role: 'judge',   what: '帧中途复位逐寄存器比对 (G-C-04)' },
  { name: 'tb_cp_remove_stability', out: 'tb_stab.vvp',   role: 'judge',   what: 'boundary/stress/backpressure (G-C-05)' },
  { name: 'tb_cp_remove_gap',       out: 'tb_gap.vvp',    role: 'measure', what: '帧间最小间隔测量' },
];

fs.mkdirSync(SIM, { recursive: true });

const results = [];
let hardFail = false;

for (const tb of TBS) {
  const src = path.join(PKG, 'tb', `${tb.name}.sv`);
  const vvp = path.join(SIM, tb.out);
  process.stdout.write(`── ${tb.name} … `);
  let log = '';
  let ok = false;
  try {
    if (useXsim) {
      log = runXsim(tb.name, [src, RTL]);
    } else {
      execFileSync('iverilog', ['-g2012', '-o', vvp, src, RTL], { stdio: 'pipe' });
      log = execFileSync('vvp', [vvp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    }
    ok = /RESULT:\s*PASS/.test(log);
  } catch (e) {
    // e.message 必须带上 —— 启动失败 (ENOENT 一类) 时 stdout/stderr 都是空的,
    // 只回显它们会让失败看起来毫无原因。2026-08-04 接 --xsim 时踩过。
    log = `${e.stdout || ''}${e.stderr || ''}\n[exec] ${e.message || ''}`;
    ok = false;
  }
  console.log(ok ? 'PASS' : 'FAIL');
  if (!ok) {
    hardFail = true;
    console.log(log.split(/\r?\n/).slice(-25).join('\n'));
  }
  results.push({ ...tb, ok, log });
}

if (hardFail) {
  console.error('\n[run_sim] 有 TB 未通过 —— 不写任何证据。');
  process.exit(1);
}

// ── 解析 ────────────────────────────────────────────────────────────────────
const resetLog = results.find((r) => r.name === 'tb_cp_remove_reset').log;
const stabLog = results.find((r) => r.name === 'tb_cp_remove_stability').log;
const gapLog = results.find((r) => r.name === 'tb_cp_remove_gap').log;

const registers = [];
for (const m of resetLog.matchAll(/^RESET_REG\s+(\S+)\s+(-?\d+)\s+(-?\d+)/gm)) {
  registers.push({ reg: m[1], got: Number(m[2]), want: Number(m[3]), pass: Number(m[2]) === Number(m[3]) });
}
const resetFree = [];
for (const m of resetLog.matchAll(/^RESET_FREE\s+(\S+)\s+(-?\d+)\s+(-?\d+)/gm)) {
  resetFree.push({ reg: m[1], before: Number(m[2]), after: Number(m[3]) });
}
if (!registers.length) { console.error('[run_sim] 复位 TB 没有产出 RESET_REG 行'); process.exit(1); }
if (registers.some((r) => !r.pass)) { console.error('[run_sim] 复位比对有失败项'); process.exit(1); }

const stab = {};
for (const m of stabLog.matchAll(/^STAB\s+(\w+)\s+(PASS|FAIL)\s+(\d+)\s+(.*)$/gm)) {
  stab[m[1]] = { pass: m[2] === 'PASS', beats: Number(m[3]), reason: m[4].trim() };
}
const notes = [...stabLog.matchAll(/^NOTE\s+(.*)$/gm)].map((m) => m[1].trim());
const gaps = [...gapLog.matchAll(/^GAP\s+(\d+)\s+(-?\d+)\s+(-?\d+)/gm)]
  .map((m) => ({ gap: Number(m[1]), points: Number(m[2]), first: Number(m[3]) }));

for (const k of ['boundary', 'stress', 'backpressure']) {
  if (!stab[k]) { console.error(`[run_sim] stability TB 未产出子结果 ${k}`); process.exit(1); }
  if (!stab[k].pass) { console.error(`[run_sim] 子结果 ${k} 失败`); process.exit(1); }
}

// regression: 由功能 TB 的实跑结果合成, 不是手写
const judges = results.filter((r) => r.role === 'judge');
stab.regression = {
  pass: judges.every((r) => r.ok),
  beats: Object.values(stab).reduce((a, b) => a + (b.beats || 0), 0),
  reason: `固定场景回归套件: ${judges.map((r) => `${r.name}(${r.what})`).join('; ')} —— ${judges.length}/${judges.length} 全过`,
};

console.log(`\n复位比对 ${registers.length} 项全过; 数据通路免复位寄存器 ${resetFree.length} 个已单列`);
console.log(`帧间间隔实测: ${gaps.map((g) => `gap=${g.gap}->${g.points}点`).join(', ')}`);
for (const n of notes) console.log(`NOTE ${n}`);

if (!install) {
  console.log('\n[run_sim] 全绿 (未加 --install, 未写证据)');
  process.exit(0);
}

// ── 落证据 ──────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(PG, 'stability'), { recursive: true });

const wr = (rel, obj) => {
  fs.writeFileSync(path.join(PG, rel), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  console.log(`  写 ${rel}`);
};

wr('reset-sim.json', {
  id: 'G-C-04.reset',
  method: 'mid-frame reset held 3 clk, per-register compare vs declared reset value; data-path regs are reset-free by design and listed separately',
  tool: TOOL,
  tb: 'tb_cp_remove_reset',
  registers,
  reset_free_registers: resetFree,
  reset_free_note: 'ri_data / ro_re / ro_im 按设计不复位 —— 下一拍无条件覆盖, 复位它们只占资源。TB 断言复位期间它们仍跟随输入, 若有人加了复位会先失败。',
  post_reset_restart: '复位释放后能重新起窗 (TB 已断言 64 拍内有输出)',
  pass: registers.every((r) => r.pass),
});

for (const [k, v] of Object.entries(stab)) {
  wr(path.join('stability', `${k}.json`), { ...v, tool: TOOL, tb: k === 'regression' ? judges.map((r) => r.name).join('+') : 'tb_cp_remove_stability' });
}

// 帧间间隔测量**不写进证据目录**: 它不是门禁产物, evidence-snapshot 的白名单
// (只收 gate-results / G-*.json / *.rpt / stability 之类) 会正当地拒收它。
// 它刻画的是接口契约, 所以跟包走、由 CS-2 哈希管 —— 数值一变哈希就变, 门禁看得见。
fs.writeFileSync(
  path.join(PKG, 'docs', 'frame-gap-measurement.json'),
  `${JSON.stringify({
    id: 'measurement.frame_gap',
    tool: TOOL,
    tb: 'tb_cp_remove_gap',
    note: '帧间间隔逐值测量 (非门禁产物, 供 docs/limitations.md 6 引用)。points = 第二帧输出点数, 期望 256。',
    measurements: gaps,
    min_usable_gap: (gaps.find((g) => g.points === 256) || {}).gap ?? null,
  }, null, 2)}\n`,
  'utf8',
);
console.log('  写 docs/frame-gap-measurement.json (包内, 受 CS-2 哈希管)');

console.log('\n[run_sim] 证据已落盘。下一步: node engineering-assets/tools/gate-runner.cjs cbb/cp_remove --repo-root .');
