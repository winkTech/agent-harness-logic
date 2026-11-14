#!/usr/bin/env node
'use strict';
/**
 * run_sim.cjs — eq_zf 的判据 TB 实跑入口, 并把**实跑结果**落成门禁证据。
 *
 * 用法:
 *   node engineering-assets/incubator/intake/eq_zf/run_sim.cjs [--install] [--xsim]
 *     --install  把证据写到 var/gates/pg/eq_zf/ (不加只跑不落盘)
 *     --xsim     用 Vivado xsim 而非 iverilog (第二仿真器交叉验证)
 *
 * 证据全部由**解析真实输出**得到, 不是人工填:
 *   tb-selfcheck.json          G-B-03  {pass, compares, tool}
 *   stability/boundary.json    G-C-05  归一化两端 + 符号边界
 *   stability/stress.json      G-C-05  2304 点满吞吐位真
 *   stability/backpressure.json G-C-05 三种反压 + 包络外溢出可见
 *   stability/regression.json  G-C-05  四个 TB 合并
 *   reset-sim.json             G-C-04  逐寄存器复位比对 + 少复位存储阵列未被清零
 *
 * reset-sim.json 的数字全部来自 tb_eq_reset 的真实输出 (REGS/BAD/KEEP/CLEARED 一行),
 * 抠不到就判 fail —— 不允许"文件在但没做过"。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG = __dirname;
const RTL = path.join(PKG, 'rtl');
const TB = path.join(PKG, 'tb');
// 逐级上溯找到含 engineering-assets 的那一层, 而不是写死上溯几层 ——
// 包从 incubator/intake/eq_zf 迁到 cbb/eq_zf 时深度会变, 写死就会指偏。
const REPO = (() => {
  let d = PKG;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'engineering-assets', 'tools'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error('找不到仓库根 (含 engineering-assets/tools 的目录)');
})();
const OUT = path.join(REPO, 'engineering-assets', 'var', 'gates', 'pg', 'eq_zf');

const install = process.argv.includes('--install');
const useXsim = process.argv.includes('--xsim');
const TOOL = useXsim ? 'Vivado xsim 2023.1' : 'Icarus Verilog (iverilog -g2012 / vvp)';

const RTLS = ['eq_zf.sv', 'eq_recip.sv', 'eq_reorder.sv'].map((f) => path.join(RTL, f));

const SUITES = [
  { name: 'tb_eq_zf', srcs: [path.join(TB, 'tb_eq_zf.sv'), ...RTLS] },
  { name: 'tb_eq_recip', srcs: [path.join(TB, 'tb_eq_recip.sv'), path.join(RTL, 'eq_recip.sv')] },
  { name: 'tb_eq_reorder', srcs: [path.join(TB, 'tb_eq_reorder.sv'), path.join(RTL, 'eq_reorder.sv')] },
  { name: 'tb_eq_reset', srcs: [path.join(TB, 'tb_eq_reset.sv'), ...RTLS] },
];

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, err: r.error ? r.error.message : '' };
}

function run(suite) {
  // cwd 必须是 rtl/ —— TB 用 ../vectors/*.hex 的相对路径读判卷向量
  if (useXsim) {
    const c = sh('xvlog', ['--sv', ...suite.srcs], RTL);
    if (c.code !== 0) return { ...suite, ok: false, log: `xvlog 失败:\n${c.out}${c.err}` };
    const e = sh('xelab', ['-debug', 'typical', '-timescale', '1ns/1ps', suite.name, '-s', `${suite.name}_s`], RTL);
    if (e.code !== 0) return { ...suite, ok: false, log: `xelab 失败:\n${e.out}${e.err}` };
    const s = sh('xsim', [`${suite.name}_s`, '-R'], RTL);
    return { ...suite, ok: /RESULT: PASS/.test(s.out), log: s.out };
  }
  const outBin = path.join(RTL, `${suite.name}.out`);
  const c = sh('iverilog', ['-g2012', '-o', outBin, ...suite.srcs], RTL);
  if (c.code !== 0) return { ...suite, ok: false, log: `iverilog 失败:\n${c.out}${c.err}` };
  const s = sh('vvp', [outBin], RTL);
  try { fs.unlinkSync(outBin); } catch { /* 清理失败不影响判定 */ }
  return { ...suite, ok: /RESULT: PASS/.test(s.out), log: s.out };
}

const results = SUITES.map((s) => { const r = run(s); console.log(`[run_sim] ${s.name}: ${r.ok ? 'PASS' : 'FAIL'}`); return r; });
const byName = Object.fromEntries(results.map((r) => [r.name, r]));
const allOk = results.every((r) => r.ok);

// ---- 从真实输出里抠数字 (抠不到就报 0, 不猜) --------------------------------
const num = (log, re) => { const m = re.exec(log || ''); return m ? Number(m[1]) : 0; };
const okCount = (log) => ((log || '').match(/^\s*\[ok\]/gm) || []).length;

const zfPts = num(byName.tb_eq_zf.log, /T1 输出点数 (\d+)/);
const zfMis = num(byName.tb_eq_zf.log, /X 失配 (\d+) 点/);
const recipPts = num(byName.tb_eq_recip.log, /CHECKED (\d+)/);
const recipLut = /T0 ROM 闭式 == 镜像导出 hex \(256 项, 失配 0\)/.test(byName.tb_eq_recip.log || '') ? 256 : 0;
const roPts = num(byName.tb_eq_reorder.log, /送入 \d+ 出 (\d+)/);
const compares = zfPts + recipPts + recipLut + roPts;
const judgements = results.reduce((n, r) => n + okCount(r.log), 0);

const bpOk = /T6 反压模式 1 \(包络内\).*失配 0/.test(byName.tb_eq_zf.log || '')
  && /T6 反压模式 2 \(包络内\).*失配 0/.test(byName.tb_eq_zf.log || '')
  && /T6b 包络外反压.*溢出 1/.test(byName.tb_eq_zf.log || '');
// 复位证据: 只认 tb_eq_reset 打出的那一行汇总, 抠不到就是 0 -> 判 fail
const rstLine = /REGS (\d+) BAD (\d+) KEEP (\d+) CLEARED (\d+)/.exec(byName.tb_eq_reset.log || '');
const rstRegs = rstLine ? Number(rstLine[1]) : 0;
const rstBad = rstLine ? Number(rstLine[2]) : 1;
const rstKeep = rstLine ? Number(rstLine[3]) : 0;
const rstClr = rstLine ? Number(rstLine[4]) : 1;

const bdOk = /T1 标定 h2=2\^28/.test(byName.tb_eq_recip.log || '')
  && /T0 ROM 闭式/.test(byName.tb_eq_recip.log || '')
  && /T1\/T2 闭式重排/.test(byName.tb_eq_reorder.log || '');

const evidence = {
  'tb-selfcheck.json': {
    pass: allOk && zfMis === 0 && compares > 0,
    compares,
    tool: TOOL,
    detail: `位真 ${zfPts} 点 0 容差 (对 rtl_mirror_eq 导出的期望值, 失配 ${zfMis}); `
      + `倒数核 ${recipPts} 点对 TB 内独立 SV 参考逐位 + ROM ${recipLut}/256 项对镜像 hex; `
      + `重排 ${roPts} 点闭式。共 ${judgements} 条判据全过。`,
    suites: results.map((r) => ({ name: r.name, pass: r.ok, judgements: okCount(r.log) })),
  },
  'stability/stress.json': {
    pass: allOk && zfPts === 2304 && zfMis === 0,
    reason: `满吞吐 48 符号 x 48 载波 = ${zfPts} 点, 对治理侧镜像 0 容差位真, 失配 ${zfMis}; `
      + `Y 路 FIFO 未溢出。`,
  },
  'stability/backpressure.json': {
    pass: allOk && bpOk,
    reason: '包络内两种反压 (随机 75% / 周期性长拉低) 与无反压基准逐点相同 —— 反压只改时刻不改数值; '
      + '包络外 (下游 50% < Y 的占空 80%) 拉起 o_y_overflow 而非静默丢点。',
  },
  'stability/boundary.json': {
    pass: allOk && bdOk,
    reason: '归一化两端: h2=2^31 (lz=0, 唯一需右移) 与 h2=1 (lz=31, 最大左移); 标定 h2=2^28 -> sh=31/r1=32767 闭式逐位; '
      + 'ROM 闭式与镜像导出 hex 256 项逐项相同; 重排的符号边界 (连送 6 符号不串, 乒乓切换)。',
  },
  'stability/regression.json': {
    pass: allOk,
    reason: `四个判据 TB 合并: ${results.map((r) => `${r.name}=${r.ok ? 'PASS' : 'FAIL'}`).join(', ')}; `
      + `共 ${judgements} 条判据。仿真器: ${TOOL}。`,
  },
  'reset-sim.json': {
    pass: allOk && rstRegs > 0 && rstBad === 0 && rstKeep > 0 && rstClr === 0,
    tool: TOOL,
    registers_compared: rstRegs,
    register_mismatches: rstBad,
    no_reset_arrays_checked: rstKeep,
    no_reset_arrays_cleared: rstClr,
    method: '注入复位前先断言状态是脏的 (符号相位已推进 / Y 路 FIFO 指针非零 / 流水在跑 / '
      + '重排 bank 已在填) —— 对着空设计复位永远会过, 那种 PASS 没有信息量。'
      + `随后保持复位 3 拍, 对 ${rstRegs} 个受复位控制的寄存器逐个比对其**声明的**复位值 `
      + '(清单写死在 tb_eq_reset 里, 不通配); 并断言 4 个少复位存储阵列 '
      + '(r_yfifo / r_ofifo / r_mem0 / r_mem1) **未被清零** —— 它们的写使能全由已复位的 '
      + 'valid 链产生, 复位期间恒为 0, 若被清零说明有人给数据通路加了复位, 会阻断宏吸收。'
      + '无条件锁存的流水寄存器 (ri_ydat / rA_y / rB_h2 / r_dly / r2_r0 / ro_r1 等) 不在 '
      + 'keep 判据内: "少复位"是不加复位而非冻结, 复位期间上游仍在驱动时它们本就会跟着变。'
      + '最后释放复位并重入一整帧, 输出须逐点正确。',
    cdc: '单时钟域 i_clk, 无跨时钟路径; cdc-report.json 由 gate-runner 结构扫描生成。',
  },
};

// ---- "没跑起来" 与 "跑了没过" 必须分开 ------------------------------------
// judgements===0 说明该 suite 一行判据都没产出 —— xelab/iverilog 失败、向量路径错
// 之类的**工具链故障**, 不是一个合法的判定结果。若照旧带 pass:false 落盘, 它会覆盖
// 掉已封存的好证据, 而证据文件里"工具坏了"与"RTL 回归了"长得一模一样: 前者该修工具,
// 后者该查 RTL。
// 库内 cp_remove / fft64_sdf / sb_align 三件本就这么做 (`!registers.length` /
// `!stab[k]` 即退出), 本件 1.1.1 补齐同一语义。退出码 2 与真实失败的 1 区分。
const notRun = results.filter((r) => okCount(r.log) === 0);
if (notRun.length) {
  console.error(`[run_sim] 未产出任何判据行, 判定为**未跑起来**: ${notRun.map((r) => r.name).join(', ')}`);
  for (const r of notRun) {
    console.error(`--- ${r.name} 的输出 (前 8 行) ---`);
    console.error((r.log || '(空)').split('\n').slice(0, 8).join('\n'));
  }
  console.error('[run_sim] 拒绝落盘 —— 工具链故障不得写进证据。');
  process.exit(2);
}

if (!install) {
  console.log('[run_sim] 未加 --install, 只跑不落盘。摘要:');
  console.log(JSON.stringify(evidence['tb-selfcheck.json'], null, 1));
  process.exit(allOk ? 0 : 1);
}

fs.mkdirSync(path.join(OUT, 'stability'), { recursive: true });
for (const [rel, obj] of Object.entries(evidence)) {
  fs.writeFileSync(path.join(OUT, rel), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  console.log(`[run_sim] 写入 ${rel}  pass=${obj.pass}`);
}
console.log(`[run_sim] 证据落盘: ${OUT}`);
process.exit(allOk ? 0 : 1);
