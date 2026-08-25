#!/usr/bin/env node
//=============================================================================
// run_sim.cjs — sb_align 的可复现仿真入口 (G-GATE-02 声明的那个)
//
//   node engineering-assets/incubator/intake/sb_align/run_sim.cjs            # 只跑
//   node engineering-assets/incubator/intake/sb_align/run_sim.cjs --install  # 跑 + 落证据
//
// 本件是**结构原语** (kind=primitive): 无算法 golden 可对标, 故 G-B-03 的判据是
// "自检 TB 实跑 PASS 证据" (tb-selfcheck.json, 决策⑦) 而非 bit-true 对拍。
//
// **证据只能由实跑结果生成**: pass 字段来自 TB 自己打印的判定, 本脚本不构造 true。
// TB 不过即整体失败且**不写**任何证据。
//
// 链路级判据 tb/integration/tb_ce_aligned 不在本脚本内 —— 它需要 channel_est_top
// 的 RTL 且必须用 xsim (iverilog 编译不了那个模块), 属跨包集成验证, 复现命令见
// README §6。
//=============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG = __dirname;
const REPO = path.resolve(PKG, '..', '..', '..');   // cbb/<uid> -> engineering-assets -> 仓库根
const PG = path.join(REPO, 'engineering-assets', 'var', 'gates', 'pg', 'sb_align');
const SIM = path.join(PKG, 'sim');
const RTL = path.join(PKG, 'rtl', 'sb_align.sv');
const install = process.argv.includes('--install');

const TOOL = 'Icarus Verilog (iverilog -g2012 / vvp)';
const TB = 'tb_sb_align';

const TBS = [
  { name: 'tb_sb_align',           out: 'tb.vvp',       what: '侧带领先/透传/瞬态反压/溢出可见/复位' },
  { name: 'tb_sb_align_reset',     out: 'tb_reset.vvp', what: '跑起来后复位, 逐寄存器比对 (G-C-04)' },
  { name: 'tb_sb_align_stability', out: 'tb_stab.vvp',  what: 'boundary/stress/backpressure (G-C-05)' },
];

fs.mkdirSync(SIM, { recursive: true });

const results = [];
let hardFail = false;
for (const tb of TBS) {
  process.stdout.write(`── ${tb.name} … `);
  let tlog = '';
  let tok = false;
  try {
    execFileSync('iverilog', ['-g2012', '-o', path.join(SIM, tb.out),
      path.join(PKG, 'tb', `${tb.name}.sv`), RTL], { stdio: 'pipe' });
    tlog = execFileSync('vvp', [path.join(SIM, tb.out)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    tok = /RESULT:\s*PASS/.test(tlog);
  } catch (e) {
    // e.message 必须带上 —— 启动失败时 stdout/stderr 都是空的
    tlog = `${e.stdout || ''}${e.stderr || ''}\n[exec] ${e.message || ''}`;
    tok = false;
  }
  console.log(tok ? 'PASS' : 'FAIL');
  if (!tok) { hardFail = true; console.log(tlog.split(/\r?\n/).slice(-25).join('\n')); }
  results.push({ ...tb, ok: tok, log: tlog });
}

if (hardFail) {
  console.error('\n[run_sim] 有 TB 未通过 —— 不写任何证据。');
  process.exit(1);
}

const log = results[0].log;
const resetLog = results.find((r) => r.name === 'tb_sb_align_reset').log;
const stabLog = results.find((r) => r.name === 'tb_sb_align_stability').log;

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
for (const k of ['boundary', 'stress', 'backpressure']) {
  if (!stab[k]) { console.error(`[run_sim] stability TB 未产出子结果 ${k}`); process.exit(1); }
  if (!stab[k].pass) { console.error(`[run_sim] 子结果 ${k} 失败`); process.exit(1); }
}
stab.regression = {
  pass: results.every((r) => r.ok),
  beats: Object.values(stab).reduce((a, b) => a + (b.beats || 0), 0),
  reason: `固定场景回归套件: ${results.map((r) => `${r.name}(${r.what})`).join('; ')} —— ${results.length}/${results.length} 全过`,
};

// 从主 TB 输出里数实际比对次数: 5 个场景各自打了一行小结
const scenarios = (log.match(/^ {2}T\d/gm) || []).length;
if (scenarios < 5) {
  console.error(`[run_sim] TB 只报告了 ${scenarios} 个场景, 期望 5 —— 证据不完整, 不写`);
  process.exit(1);
}

console.log(log.split(/\r?\n/).filter((l) => /^ {2}T\d/.test(l)).join('\n'));

if (!install) {
  console.log('\n[run_sim] 全绿 (未加 --install, 未写证据)');
  process.exit(0);
}

fs.mkdirSync(path.join(PG, 'stability'), { recursive: true });

const wr = (rel, obj) => {
  fs.writeFileSync(path.join(PG, rel), `${JSON.stringify(obj, null, 2)}
`, 'utf8');
  console.log(`  写 ${rel}`);
};

wr('reset-sim.json', {
  id: 'G-C-04.reset',
  method: 'FIFO 堆满且溢出置起后拉复位保持 3 clk (输入继续翻转), 逐寄存器比对复位值',
  tool: TOOL,
  tb: 'tb_sb_align_reset',
  registers,
  reset_free_registers: resetFree,
  reset_free_note: '存储阵列 r_mem 按设计不复位 —— 读侧永远只读已写过的槽 (由 w_empty 保证), '
    + '复位它只占资源。TB 断言复位期间它保持不变而非被清零, 防将来有人加了复位却不更新比对表。',
  post_reset_restart: '复位释放后重新灌 64 拍, 全部 64 个样点被送出且不再溢出',
  pass: registers.every((r) => r.pass),
});

for (const [k, v] of Object.entries(stab))
  wr(path.join('stability', `${k}.json`), { ...v, tool: TOOL,
    tb: k === 'regression' ? results.map((r) => r.name).join('+') : 'tb_sb_align_stability' });

const out = {
  id: 'G-B-03.tb-selfcheck',
  pass: true,
  compares: scenarios,
  tool: TOOL,
  tb: TB,
  method: '结构原语无算法 golden, 故本门为自检 TB 实跑 PASS 证据 (决策⑦)',
  scenarios: [
    'T1/T2 侧带领先恰好 1 拍且该拍 tvalid 为低; 数据逐点透传不丢不重不乱序',
    'T3 瞬态反压 (每符号头 3 拍, <= P_DEPTH-1) 下输出与无反压逐点一致且未溢出',
    'T4 下游长时间不收时 o_overflow 置起并粘滞 —— 溢出必须可见而非静默丢',
    'T5 复位后清零并能重新工作',
  ],
  integration_judgement: 'tb/integration/tb_ce_aligned (xsim): 接真实 channel_est_top, '
    + '同一激励同一参考下 H 输出由 372/384 点不同变为 **0 点不同**, 且未溢出 —— '
    + '这是本件存在意义的直接判据, 复现命令见 README 6',
};
fs.writeFileSync(path.join(PG, 'tb-selfcheck.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log('\n  写 tb-selfcheck.json');
console.log('[run_sim] 证据已落盘。下一步: node engineering-assets/tools/gate-runner.cjs incubator/intake/sb_align --repo-root .');
