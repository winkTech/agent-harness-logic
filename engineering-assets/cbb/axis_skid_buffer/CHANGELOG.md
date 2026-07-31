# CHANGELOG — axis_skid_buffer

## [1.0.0] — 2026-07-31 转正 certified（首个 primitive 全流程认证，ADR-001 参考实现落地件）

- ADR-001（AXIS tready 分级判据）accepted 后，本模块作为其"寄存 tready + skid"
  参考实现走完 primitive 类 certified 全流程（决策⑦：正确性锚 = 自检 TB）。
- TB 升级为 certified 证据链：`+EVID_DIR` 落盘 `tb-selfcheck.json`（1966 拍比对
  0 失配、1337 次保持检查）、`reset-sim.json`（7 寄存器逐一复位比对）、
  `stability/{boundary,stress,regression,backpressure}.json` 四个具名子结果；
  新增 C7 容量边界检查（主+skid 填满后 tready 必须撤销）与单/双 beat 帧、
  重度背压（~12.5% ready 占空比）场景。
- 综合取证（pg-synth, OOC @ xc7k325tffg900-2, 250 MHz 约束）：WNS +2.605 ns /
  WHS +0.217 ns，资源在包络内（预算 LUT/FF ≤ 80，BRAM/DSP = 0）。
- 新增 `constraints/axis_skid_buffer.xdc` 与 `tb/run_sim.do`（ModelSim 一键跑，
  root 走査以 cwd 为基准——`[info script]` 在 ModelSim 10.6 的 do 中会解析到盘根）。

## [0.1.0] — 2026-07-27 intake（批次 1 入库）

- 改写自 `skills/hdl-coding/templates/comm/axis_pipeline_reg.sv`，修复原件四处
  缺陷（tready 组合穿通/命名/无 tlast/全局停顿结构），全寄存输出 + 1 深 skid，
  满吞吐；自检 TB C1-C6（队列记分板、X 计失配、零比较 fatal 反假绿约定）。
