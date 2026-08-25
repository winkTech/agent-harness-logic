#!/usr/bin/env node
'use strict';
/**
 * run_sim.cjs — mod_demapper 的判据 TB 实跑入口, 并把**实跑结果**落成门禁证据。
 *
 * 用法:
 *   node engineering-assets/incubator/intake/mod_demapper/run_sim.cjs [--install] [--xsim]
 *     --install  把证据写到 var/gates/pg/mod_demapper/ (不加只跑不落盘)
 *     --xsim     用 Vivado xsim 而非 iverilog (第二仿真器交叉验证)
 *
 * 与 eq_zf 的差别: 顶层 TB 要**按调制跑三遍** (向量目录 / bps / mod 由 plusarg 传入),
 * 因为 K 是分档的、每轴电平数不同、sh' 值域也逐档不同 —— 只跑一档等于只验了三分之一。
 *
 * 证据全部由**解析真实输出**得到, 不是人工填:
 *   tb-selfcheck.json           G-B-03  {pass, compares, tool}
 *   stability/stress.json       G-C-05  三档满吞吐位真 + 实测吞吐拍数
 *   stability/backpressure.json G-C-05  三种出侧反压 + 上游断续, 与基准**逐点相同**
 *   stability/boundary.json     G-C-05  sh' 47/48 分界 / 饱和 / 擦除哨兵 / 电平上与中点
 *   stability/regression.json   G-C-05  六次实跑合并
 *   reset-sim.json              G-C-04  逐寄存器复位比对 + 少复位寄存器未被清零
 *
 * reset-sim.json 的数字全部来自 tb_demap_reset 的真实输出 (REGS/BAD/KEEP/NOTCLR 一行),
 * 抠不到就判 fail —— 不允许"文件在但没做过"。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG = __dirname;
const RTL = path.join(PKG, 'rtl');
const TB = path.join(PKG, 'tb');
// 逐级上溯找到含 engineering-assets 的那一层, 而不是写死上溯几层 ——
// 包从 incubator/intake/mod_demapper 迁到 cbb/mod_demapper 时深度会变, 写死就指偏。
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
const OUT = path.join(REPO, 'engineering-assets', 'var', 'gates', 'pg', 'mod_demapper');

const install = process.argv.includes('--install');
const useXsim = process.argv.includes('--xsim');
const TOOL = useXsim ? 'Vivado xsim 2023.1' : 'Icarus Verilog (iverilog -g2012 / vvp)';

const R_TOP = path.join(RTL, 'mod_demapper.sv');
const R_MET = path.join(RTL, 'demap_metric.sv');
const R_SCL = path.join(RTL, 'demap_scale.sv');
const RTLS = [R_TOP, R_MET, R_SCL];

// 三档: 目录 / bps / i_mod 编码。K 与电平数由 RTL 按 mod 自选, TB 只负责喂对向量。
const MODS = [
  { key: 'qpsk', bps: 2, sel: 0, k: 2 },
  { key: '16qam', bps: 4, sel: 1, k: 16 },
  { key: '64qam', bps: 6, sel: 2, k: 32 },
];

const SUITES = [
  { name: 'tb_demap_metric', top: 'tb_demap_metric', srcs: [path.join(TB, 'tb_demap_metric.sv'), R_MET], plus: [] },
  { name: 'tb_demap_scale', top: 'tb_demap_scale', srcs: [path.join(TB, 'tb_demap_scale.sv'), R_SCL], plus: [] },
  { name: 'tb_demap_reset', top: 'tb_demap_reset', srcs: [path.join(TB, 'tb_demap_reset.sv'), ...RTLS], plus: [] },
  ...MODS.map((m) => ({
    name: `tb_mod_demapper[${m.key}]`,
    top: 'tb_mod_demapper',
    srcs: [path.join(TB, 'tb_mod_demapper.sv'), ...RTLS],
    plus: [`+VDIR=../vectors/${m.key}`, `+BPS=${m.bps}`, `+MOD=${m.sel}`],
    mod: m,
  })),
];

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, err: r.error ? r.error.message : '' };
}

function run(suite) {
  // cwd 必须是 rtl/ —— TB 用 ../vectors/*.hex 的相对路径读判卷向量
  if (useXsim) {
    const snap = `${suite.top}_${(suite.mod && suite.mod.key) || 's'}`;
    const c = sh('xvlog', ['--sv', ...suite.srcs], RTL);
    if (c.code !== 0) return { ...suite, ok: false, log: `xvlog 失败:\n${c.out}${c.err}` };
    const e = sh('xelab', ['-debug', 'typical', '-timescale', '1ns/1ps', suite.top, '-s', snap], RTL);
    if (e.code !== 0) return { ...suite, ok: false, log: `xelab 失败:\n${e.out}${e.err}` };
    // plusarg **必须走 -f 选项文件**, 不能直接放命令行。
    // Windows 上 `xsim` 是批处理包装器, 转发 `-testplusarg NAME=VALUE` 时会把 `=`
    // 吃掉 -> xsim 报 "Expected a switch but found <值>" 并打印 usage 退出。
    // 后果不是报错那么简单: 顶层 TB 根本没启动, 却被记成 pass:false / judgements:0,
    // 与"跑了但没过"在证据文件里长得一模一样。1.0.1 修。
    let s;
    if (suite.plus.length) {
      const optf = path.join(RTL, `xsim_${snap}.f`);
      fs.writeFileSync(optf, `${suite.plus.map((p) => `-testplusarg ${p.replace(/^\+/, '')}`).join('\n')}\n`, 'utf8');
      s = sh('xsim', [snap, '-R', '-f', path.basename(optf)], RTL);
      try { fs.unlinkSync(optf); } catch { /* 清理失败不影响判定 */ }
    } else {
      s = sh('xsim', [snap, '-R'], RTL);
    }
    return { ...suite, ok: /RESULT: PASS/.test(s.out), log: s.out };
  }
  const outBin = path.join(RTL, `${suite.top}_${(suite.mod && suite.mod.key) || 's'}.out`);
  const c = sh('iverilog', ['-g2012', '-o', outBin, ...suite.srcs], RTL);
  if (c.code !== 0) return { ...suite, ok: false, log: `iverilog 失败:\n${c.out}${c.err}` };
  const s = sh('vvp', [outBin, ...suite.plus], RTL);
  try { fs.unlinkSync(outBin); } catch { /* 清理失败不影响判定 */ }
  return { ...suite, ok: /RESULT: PASS/.test(s.out), log: s.out };
}

const results = SUITES.map((s) => {
  const r = run(s);
  console.log(`[run_sim] ${s.name}: ${r.ok ? 'PASS' : 'FAIL'}`);
  if (!r.ok) console.log(r.log.split('\n').filter((l) => /FAIL|\[X\]|失败/.test(l)).slice(0, 12).join('\n'));
  return r;
});
const byName = Object.fromEntries(results.map((r) => [r.name, r]));
const allOk = results.every((r) => r.ok);

// ---- 从真实输出里抠数字 (抠不到就报 0, 不猜) --------------------------------
const num = (log, re) => { const m = re.exec(log || ''); return m ? Number(m[1]) : 0; };
const okCount = (log) => ((log || '').match(/^\s*\[ok\]/gm) || []).length;

const judgements = results.reduce((n, r) => n + okCount(r.log), 0);

// 顶层三档: 比对数 / 失配数 / 吞吐拍数 / erasure 违例
const perMod = MODS.map((m) => {
  const log = byName[`tb_mod_demapper[${m.key}]`].log || '';
  const llrs = num(log, /T1 逐 LLR 0 容差比对镜像 \((\d+) 个\)/);
  const mism = num(log, /比对镜像 \(\d+ 个\): 失配 (\d+)/);
  const pts = num(log, /T3 出入守恒: 送入 (\d+) 点/);
  const cyc = num(log, /T8 吞吐 (\d+) 拍/);
  const erN = num(log, /T6 erasure 载波 (\d+) 个/);
  const erBad = num(log, /违例 (\d+)\)/);
  const bpOk = (log.match(/T4 出侧反压模式 \d 与基准逐点相同/g) || []).length === 3;
  const gapOk = /T5 上游断续注入与基准逐点相同/.test(log);
  const tlOk = /T2 tlast 恰在每符号最后一个比特/.test(log);
  return { key: m.key, k: m.k, bps: m.bps, llrs, mism, pts, cyc, erN, erBad, bpOk, gapOk, tlOk,
           cyclesPerPoint: pts ? Number((cyc / pts).toFixed(2)) : 0 };
});

const totalLlr = perMod.reduce((n, p) => n + p.llrs, 0);
const totalMism = perMod.reduce((n, p) => n + p.mism, 0);

// 子模块: 用"送 N 出 N"那行的出数当比对数
const metCmp = num(byName.tb_demap_metric.log, /T3b o_valid 与 i_valid 一一对应: 送 \d+ 出 (\d+)/);
const sclCmp = num(byName.tb_demap_scale.log, /T5b o_valid 一一对应: 送 \d+ 出 (\d+)/);

// 复位证据: 只认 tb_demap_reset 打出的那一行汇总, 抠不到就是 0 -> 判 fail
const rstLine = /REGS (\d+)\s+BAD (\d+)\s+KEEP (\d+)\s+NOTCLR (\d+)/.exec(byName.tb_demap_reset.log || '');
const rstRegs = rstLine ? Number(rstLine[1]) : 0;
const rstBad = rstLine ? Number(rstLine[2]) : 1;
const rstKeep = rstLine ? Number(rstLine[3]) : 0;
const rstClr = rstLine ? Number(rstLine[4]) : 0;

const compares = totalLlr + metCmp + sclCmp + rstRegs + rstKeep;

// 边界: 三处各自独立, 缺一不可
const bdScale = /T2 sh' 扫 28\.\.66 \(含 47\/48 分界\) 对全精度参考 0 容差: 失配 0/.test(byName.tb_demap_scale.log || '')
  && /T3 饱和: 失配 0, 触顶 1 触底 1/.test(byName.tb_demap_scale.log || '');
const bdMetric = /T2 边界 \d+ 点对参考模型 0 容差 \(失配 0\)/.test(byName.tb_demap_metric.log || '');
const bdErase = perMod.every((p) => p.erN > 0 && p.erBad === 0);
// 注: sh' 的**值域**判据 (逐档 [33-log2K, 67-log2K]、全档上界 66 -> 字段 7 位) 在治理侧
// test_rtl_mirror_demap 的 T5, 不在本文件。这里不写一个恒真的占位量充数 ——
// 首版写了 `... || true`, 那是个看着像检查其实什么都不查的东西。

const bpAllOk = perMod.every((p) => p.bpOk && p.gapOk);
// 吞吐预算: 100MHz / (20MHz@80 样点每符号) = 每符号 400 拍装 48 个载波 -> 8.33 拍/点
const THR_BUDGET = 400 / 48;
const thrOk = perMod.every((p) => p.cyclesPerPoint > 0 && p.cyclesPerPoint <= THR_BUDGET);

const evidence = {
  'tb-selfcheck.json': {
    pass: allOk && totalMism === 0 && totalLlr > 0 && compares > 0,
    compares,
    tool: TOOL,
    detail: `顶层三档逐 LLR 0 容差 (对治理侧 rtl_mirror_demap 导出的期望值): `
      + perMod.map((p) => `${p.key} ${p.llrs} 个/K=${p.k}`).join(', ')
      + ` = 共 ${totalLlr} 个, 失配 ${totalMism}; `
      + `metric 核 ${metCmp} 点对 TB 内**循环式**参考 (DUT 是固定 4 路 min 树, 结构不同才算互证); `
      + `scale 核 ${sclCmp} 组对 TB 内 96 位全精度参考 (不走 sh'>=48 恒 0 的捷径); `
      + `复位逐寄存器 ${rstRegs} 项 + 少复位 ${rstKeep} 项。共 ${judgements} 条判据全过。`,
    suites: results.map((r) => ({ name: r.name, pass: r.ok, judgements: okCount(r.log) })),
  },
  'stability/stress.json': {
    pass: allOk && totalMism === 0 && perMod.every((p) => p.pts === 2304) && thrOk,
    reason: `三档各满吞吐 2304 点 (48 符号 x 48 载波, 过 G-B-03 的 >=2048), 对治理侧镜像 0 容差位真, `
      + `合计 ${totalLlr} 个 LLR 失配 ${totalMism}; `
      + `实测吞吐 ${perMod.map((p) => `${p.key} ${p.cyclesPerPoint}`).join(' / ')} 拍每点, `
      + `预算 ${THR_BUDGET.toFixed(2)} (100MHz 下每 OFDM 符号 400 拍要装 48 个载波)。`,
    throughput: perMod.map((p) => ({ mod: p.key, bps: p.bps, cycles: p.cyc, points: p.pts, cyclesPerPoint: p.cyclesPerPoint })),
    budget_cycles_per_point: Number(THR_BUDGET.toFixed(2)),
    note: '吞吐是**接口形状的依据**而不是附带指标: 串行 LLR 输出成立的前提就是 48xbps < 400 拍。'
      + '若按 20MHz 时钟算 64QAM 需 288 拍 > 80, 串行根本走不通, 必须改成并出 bps 个。'
      + '故它必须是一条判据 (T8), 不能只是设计注释里的一次心算。',
  },
  'stability/backpressure.json': {
    pass: allOk && bpAllOk,
    reason: '三种出侧反压 (随机 75% / 周期性长阻塞 / 每拍交替) 与无反压基准**逐点相同** —— '
      + '判据是"逐点相同"而不是"也能跑完", 后者放得过"反压时算错但仍出数"这类缺陷; '
      + '另加上游断续注入 (随机插空拍) 同样逐点相同。三档均验。',
    per_mod: perMod.map((p) => ({ mod: p.key, backpressure_3modes: p.bpOk, upstream_gaps: p.gapOk })),
  },
  'stability/boundary.json': {
    pass: allOk && bdScale && bdMetric && bdErase,
    reason: `末级 sh' 逐值扫 28..66 含 **47/48 分界** (即 ">=48 结果可证恒 0" 那条捷径的两侧), `
      + '对 96 位全精度参考 0 容差 —— 捷径是被验证的而不是被相信的; '
      + '饱和触顶触底均打到且不回绕 (回绕会变号, 在译码器眼里是"高置信度的错误比特"); '
      + 'metric 边界含恰在电平上 (metric 一侧恰为 0, min 树比较写反会露头) / 紧贴两电平中点的'
      + '可表示两侧 (真中点多半不是 Q4.12 整数, RTL 永远见不到) / 冲出星座之外; '
      + `擦除 ${perMod.map((p) => `${p.key} ${p.erN} 个`).join(' ')} 载波 LLR 全 0 违例 `
      + `${perMod.reduce((n, p) => n + p.erBad, 0)} —— 单独判而不是混在总数里, `
      + '因为 conf=0 时数据通路自然也给 0, 两条路径的错会互相遮掩。',
  },
  'stability/regression.json': {
    pass: allOk,
    reason: `六次实跑合并: ${results.map((r) => `${r.name}=${r.ok ? 'PASS' : 'FAIL'}`).join(', ')}; `
      + `共 ${judgements} 条判据。仿真器: ${TOOL}。`,
  },
  'reset-sim.json': {
    pass: allOk && rstRegs > 0 && rstBad === 0 && rstKeep > 0,
    tool: TOOL,
    registers_compared: rstRegs,
    register_mismatches: rstBad,
    no_reset_regs_checked: rstKeep,
    no_reset_regs_cleared: rstClr,
    method: '注入复位前先断言状态是脏的 (出侧 FIFO 非空 / 信用被扣 / 串行化在半途), 并断言'
      + '采样到的少复位寄存器**确实非零** —— 对着空设计复位永远会过, 那种 PASS 没有信息量; '
      + '这一条首跑就抓到激励失效 (sh 取低段时 sh\'>=48 使 LLR 恒 0, 于是 "复位后仍是 0" 空转)。'
      + `随后保持复位 4 拍, 对 ${rstRegs} 个受复位控制的寄存器逐个比对其**声明的**复位值 `
      + `(清单写死在 tb_demap_reset 里, 不通配); 并断言 ${rstKeep} 个少复位寄存器逐位不变。`
      + '数据载荷少复位是**有意的** (hdl §1.1): r2_sq 与 r1_prod 是乘法器输出寄存器, '
      + '带复位会挡住 DSP 内部寄存器吸收, 其余宽载荷带复位纯属抬高控制集。谁日后顺手补上'
      + '就会在这条判据上失败 —— 那正是要的效果。'
      + '另有 T0b: **复位期间 s_axis_tready 必须为 0**。少了它上游保持 tvalid 时握手成立、'
      + 'beat 被吃掉而 ri_valid 被复位钳住, 数据静默丢失 —— 三个功能 TB 全绿也漏掉了它, '
      + '因为它们复位时不驱动 tvalid。',
    cdc: '单时钟域 i_clk, 无跨时钟路径; cdc-report.json 由 gate-runner 结构扫描生成。',
  },
};

// ---- "没跑起来" 与 "跑了没过" 必须分开 ------------------------------------
// judgements===0 说明该 suite 一行判据都没产出 —— xelab 失败 / plusarg 没传进去 /
// 向量路径错之类的**工具链故障**, 不是一个合法的判定结果。若照旧带 pass:false 落盘,
// 它会覆盖掉已封存的好证据, 而证据文件里"工具坏了"与"RTL 回归了"长得一模一样:
// 前者该修工具, 后者该查 RTL。
// 库内 cp_remove / fft64_sdf / sb_align 三件本就这么做 (`!registers.length` /
// `!stab[k]` 即退出), 本件 1.0.1 补齐同一语义。退出码 2 与真实失败的 1 区分。
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
