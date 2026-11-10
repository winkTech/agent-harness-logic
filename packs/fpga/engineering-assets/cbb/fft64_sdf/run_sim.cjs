#!/usr/bin/env node
//=============================================================================
// run_sim.cjs — fft64_sdf 的可复现仿真入口 (G-GATE-02 声明的那个)
//
//   node engineering-assets/cbb/fft64_sdf/run_sim.cjs            # 只跑
//   node engineering-assets/cbb/fft64_sdf/run_sim.cjs --install  # 跑 + 落证据
//
// 为什么用 iverilog 而不是 ModelSim: 本机 ModelSim 回环 RPC 自 2026-08-01 起故障
// (见 cbb/ldpc_codec/run_xsim.sh 头注释)。iverilog 是本机可用的回归路径。
//
// **证据只能由实跑结果生成**: 每份 JSON 的 pass 字段都来自 TB 自己打印的判定,
// 本脚本不构造 pass=true。任一 TB 未打出 RESULT: PASS 即整体失败并且**不写**
// 任何证据 —— 半份证据比没有证据更危险。
//
// 注意: bit-true 对拍 (tb_fft64_cosim) 的向量出自 models/comm/ofdm 1.4.1 的
// 治理资产。本脚本**不重新生成向量** —— 重生成属于 golden 侧动作, 入口在
// models 的 run_all_tests 与该次重推脚本, 不该混进 RTL 侧的回归。
//=============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG = __dirname;
const REPO = path.resolve(PKG, '..', '..', '..');   // cbb/<uid> -> engineering-assets -> 仓库根
const PG = path.join(REPO, 'engineering-assets', 'var', 'gates', 'pg', 'fft64_sdf');
const SIM = path.join(PKG, 'sim');
const RTLDIR = path.join(PKG, 'rtl');
const RTL = ['fft64_sdf_core.sv', 'fft64_reorder.sv', 'fft64_sdf.sv'].map((f) => path.join(RTLDIR, f));
const install = process.argv.includes('--install');
// --xsim: 换 Vivado xsim 跑**同一批 TB、同一套判据** —— 第二仿真器交叉验证。
// 只换仿真器不换判据才叫交叉验证; 换个跑法凑数不算。
const useXsim = process.argv.includes('--xsim');

const TOOL = useXsim
  ? 'Vivado xsim 2023.1 (xvlog/xelab/xsim)'
  : 'Icarus Verilog (iverilog -g2012 / vvp)';

const XBUILD = path.join(REPO, 'engineering-assets', 'var', 'build', 'xsim-fft64_sdf');

// Windows 上 Vivado 的 xvlog/xelab/xsim 可执行体是 .bat (同名无扩展文件是给 bash
// 用的 shell 脚本)。两道坎: 不带 .bat 直接调 -> ENOENT; 带了 .bat 仍 EINVAL ——
// Node 20+ 起不再直接 spawn .bat/.cmd (CVE-2024-27980), 必须经 shell。
const WIN = process.platform === 'win32';
const q = (s2) => (WIN ? `"${s2}"` : s2);

function xrun(name, args, opt) {
  if (WIN) return execFileSync(`${name}.bat`, args.map(q), { ...opt, shell: true });
  return execFileSync(name, args, opt);
}

// xelab 的 -timescale: 本包 RTL 不带 `timescale (综合不需要), 而 TB 带 ——
// xsim 会为默认参数绑定生成 <top>_default 模块并因"设计内时标不一致"报错。
// 显式统一即可; 这是仿真器环境差异, 不是 RTL 缺陷 (iverilog 无此要求)。
function runXsim(tbName, srcs) {
  fs.mkdirSync(XBUILD, { recursive: true });
  const opt = { cwd: XBUILD, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  xrun('xvlog', ['--sv', '-i', RTLDIR, ...srcs], opt);
  xrun('xelab', ['-debug', 'typical', '-timescale', '1ns/1ps', tbName, '-s', `s_${tbName}`], opt);
  return xrun('xsim', [`s_${tbName}`, '-R'], opt);
}

const TBS = [
  { name: 'tb_fft64_sdf_core',  out: 'tb.vvp',        role: 'judge', what: '解析判据: 冲激/直流/Nyquist/缩放/侧带/复位' },
  { name: 'tb_fft64_reorder',   out: 'tb_reorder.vvp', role: 'judge', what: '位反序->自然序/乒乓无串扰/侧带落位' },
  { name: 'tb_fft64_direction', out: 'tb_dir.vvp',    role: 'judge', what: '复数单音: FFT->bin1 / IFFT->bin63' },
  { name: 'tb_fft64_sdf',       out: 'tb_top.vvp',    role: 'judge', what: '顶层接线与两种输出序配置' },
  { name: 'tb_fft64_cosim',     out: 'tb_cosim.vvp',  role: 'judge', what: '**bit-true 判据**: 对治理 golden 镜像 0 容差 2560 点' },
  { name: 'tb_fft64_reset',     out: 'tb_reset.vvp',  role: 'judge', what: '流水跑满后复位, 逐寄存器比对 (G-C-04)' },
  { name: 'tb_fft64_stability', out: 'tb_stab.vvp',   role: 'judge', what: 'boundary/stress/backpressure (G-C-05)' },
  { name: 'tb_fft64_tail',      out: 'tb_tail.vvp',   role: 'judge', what: '锁定尾部不冲刷即丢符号, 以及"补 1 个符号就够"这个契约数' },
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
      log = runXsim(tb.name, [...RTL, src]);
    } else {
      execFileSync('iverilog', ['-g2012', '-I', RTLDIR, '-o', vvp, ...RTL, src], { stdio: 'pipe' });
      log = execFileSync('vvp', [vvp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    }
    ok = /RESULT:\s*PASS/.test(log);
  } catch (e) {
    // e.message 必须带上 —— 启动失败 (ENOENT/EINVAL 一类) 时 stdout/stderr 都是
    // 空的, 只回显它们会让失败看起来毫无原因。2026-08-04 接 --xsim 时踩过两次。
    log = `${e.stdout || ''}${e.stderr || ''}
[exec] ${e.message || ''}`;
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
const resetLog = results.find((r) => r.name === 'tb_fft64_reset').log;
const stabLog = results.find((r) => r.name === 'tb_fft64_stability').log;

const registers = [];
for (const m of resetLog.matchAll(/^RESET_REG\s+(\S+)\s+(-?\d+)\s+(-?\d+)/gm)) {
  registers.push({ reg: m[1], got: Number(m[2]), want: Number(m[3]), pass: Number(m[2]) === Number(m[3]) });
}
if (!registers.length) { console.error('[run_sim] 复位 TB 没有产出 RESET_REG 行'); process.exit(1); }
if (registers.some((r) => !r.pass)) { console.error('[run_sim] 复位比对有失败项'); process.exit(1); }

const stab = {};
for (const m of stabLog.matchAll(/^STAB\s+(\w+)\s+(PASS|FAIL)\s+(\d+)\s+(.*)$/gm)) {
  stab[m[1]] = { pass: m[2] === 'PASS', beats: Number(m[3]), reason: m[4].trim() };
}
for (const k of ['boundary', 'stress', 'backpressure']) {
  if (!stab[k]) { console.error(`[run_sim] stability TB 未产出子结果 ${k}`); process.exit(1); }
  if (!stab[k].pass) { console.error(`[run_sim] 子结果 ${k} 失败`); process.exit(1); }
}

const judges = results.filter((r) => r.role === 'judge');
stab.regression = {
  pass: judges.every((r) => r.ok),
  beats: Object.values(stab).reduce((a, b) => a + (b.beats || 0), 0),
  reason: `固定场景回归套件: ${judges.map((r) => `${r.name}(${r.what})`).join('; ')} —— ${judges.length}/${judges.length} 全过`,
};

console.log(`\n复位比对 ${registers.length} 项全过 (core 的 6 个 SDF 级 + 2 个复乘 + 侧带延迟线 + 输出级, 以及 reorder 的写/读/输出三段)`);
console.log('数据通路与各级 FIFO 按设计不复位 (利于 BRAM/SRL 宏吸收), 故复位后首符号仍带未初始化值 —— 契约见 docs/limitations.md 6');

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
  method: 'pipeline filled with 6 symbols, then reset held 3 clk while inputs keep toggling; per-register compare vs declared reset value',
  tool: TOOL,
  tb: 'tb_fft64_reset',
  registers,
  reset_free_note: '数据通路寄存器与各级 SDF FIFO / 重排乒乓存储按设计**不复位** —— 利于综合器把它们吸收成 BRAM/SRL 宏。'
    + '代价是复位后第一个符号会带出未初始化值, 必须预热一个符号; 这是与不复位配套的使用契约, 不是缺陷 (docs/limitations.md 6)。'
    + 'TB 已验证复位释放后能重新跑出 64 的整数倍长度的输出。',
  post_reset_restart: '复位释放后预热 1 符号再送 4 符号, 输出 512 点 (64 的整数倍)',
  pass: registers.every((r) => r.pass),
});

for (const [k, v] of Object.entries(stab)) {
  wr(path.join('stability', `${k}.json`), { ...v, tool: TOOL, tb: k === 'regression' ? judges.map((r) => r.name).join('+') : 'tb_fft64_stability' });
}

console.log('\n[run_sim] 证据已落盘。下一步: node engineering-assets/tools/gate-runner.cjs cbb/fft64_sdf --repo-root .');
