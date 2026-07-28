# CHANGELOG — channel_est_top

## 2026-07-28 — hdl-coding 规范整改

按 `docs/rules/01-hdl.md` 五条红线整改全部 RTL，并修复两个让整条信道估计链
从未产出过结果的功能缺陷（不修就无法做任何验证）。

### 编码规范变更

- 复位：全部 `negedge rst_n` 异步低有效 → 同步高有效 `i_rst`；
  `channel_interpolator` 的 delta/prod 两级此前**完全无复位**，已补齐。
- 命名：`clk/rst_n/start/pilot_*` → `i_clk/i_rst/i_start/i_pilot_*`；
  非 AXI 输出补 `o_`；内部改 `ri_/ro_/r_/w_`；FSM 状态改 `P_`。
- 红线 1：`ls_estimator` 新增 `ri_` 输入寄存级。
- 红线 2：`s_axis_tready` / `o_pilot_valid` / `o_symbol_done` / `m_axis_*`
  全部改 `ro_` 寄存驱动；插值器输出级与累加器共用统一使能，反压时整体冻结。
- 红线 4/5：三个 FSM 均改三段式并补 `default`。
- **§5 位宽修正**：`sub_idx` 原声明 `[N_FFT-1:0]`=64 位、`pilot_cnt` 原声明
  `[N_PILOT-1:0]`=4 位 —— 把「计数上限」误当「位宽」写。改为 `$clog2` 推导的
  6 位 / 3 位，并加数组索引范围保护。
- **封装**：删除 `channel_est_top.sv` 对 `u_interpolator.m_axis_tvalid` 的跨层次
  引用，改用顶层端口信号。

### 修复的两个致命功能缺陷

1. **子载波计数差一** —— `ls_estimator` 原先只在 `state == CAPTURE && 握手` 时
   计数，而 `IDLE→CAPTURE` 恰由第一个握手拍触发，**第一拍不计数**。64 拍激励下
   `sub_idx` 最多到 62，`sub_idx == N_FFT-1` 永不成立，状态机出不了 CAPTURE，
   `o_symbol_done` 从未置位过。
2. **导频计数不按符号清零** —— `pilot_cnt` 原先只有复位才清零，第一个符号抓满
   4 个导频后停在 4，之后所有符号的导频写入全部越界被丢弃。

这两项此前一直没暴露，是因为原 TB 用裸 `#5000` 延时后直接读 `m_axis_tdata`
（读到的是残留值），从未按握手捕获整个符号再比对。

### TB 修正

- 激励量化：原用 `$shortrealtobits(v*16384.0)` —— 该函数返回 IEEE-754 单精度
  **位模式**而非定点整数，送进 DUT 的是无意义比特，而 `check_h` 却按 Q2.14
  整数解释。改为 `$rtoi` 取整 + 饱和。
- 输出采样：改为按 `m_axis_tvalid` 握手捕获整符号后再逐点比对
  （原 `check_h` 的 `idx` 参数从未真正参与索引）。
- 补 `$fatal`（原实现失败也退出 0）。

### 验证

- `tb_channel_est`：Test 1 平坦信道 H=1、Test 2 复常数信道 0.5+0.5j，
  两个符号各 **64/64 子载波全部捕获**，抽查 5 个子载波（含 DC）全部在 ±3 LSB 内，
  `ALL TESTS PASSED`。**这是本包第一次跑出端到端有效结果。**
- gate-runner：`G-A-00/G-A-01/G-A-02/G-A-04/G-C-03/RL-OUT` 全绿。
