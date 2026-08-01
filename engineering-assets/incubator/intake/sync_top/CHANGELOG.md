# CHANGELOG — sync_top

## [0.2.0] — 2026-08-01 ADR-003 因果化架构重排：同步链首次全功能贯通

0.1.0 的 25 条算法/数值缺陷（含 F1 检测门限溢出虚警率 99%、F3 `fft_start`
恒 0 永不锁定、F6 CORDIC 坏流水、F7 CFO 通路整体缺失）随旧数据通路
（`packet_detect`/`fine_timing`/`cordic_core`/`sync_pkg`）整体替换而消灭。

### 架构（ADR-003 三裁决落地）

- **新增** `sync_detect`（递推滑窗自相关 + 免除法判决 `2|C>>16|²>(P>>16)²` +
  9 连平顶 + 平顶期 S_cfo 累加）、`cordic_rot_pipe`（14 级流水旋转 NCO）、
  `sync_correlator`（T1 符号量化 ±1 系数 64 抽头加法树，0 DSP）、
  `sync_track_out`（峰值搜索 + T2 防错锁 + 384 深对齐延迟线 + 输出级）；
  `cordic_cv` 自 cbb/channel_est_top 复用（求 S_cfo 相角）。
- **m_axis 因果校正契约**：`corr_start = plat_end_idx + 40` 起 NCO 旋转
  `e^{-jθ(n)}`（相位参考零于该点），之前样点 θ=0 过同一流水
  （≈恒等 ±8 LSB CORDIC 截断抖动）；m_axis 相对 s_axis 固定延迟 384 拍。
- **T2 防错锁**（因果结构性）：corr_start 落于 GI2/T1 边界致 T1 前段未校正、
  T2（=T1+64，全校正）峰值更高——峰值定格后回查 pk-64，
  `|R(pk-64)|² ≥ |R(pk)|²/4` 即取 pk-64。实测定时由 +64 错锁恢复到 **0 误差**。
- `o_fft_start` 与 m_axis 上 T1 首样点**同拍**；`o_sync_locked` 保持到复位；
  无反压契约（`m_axis_tready` 忽略，文档化）。

### 验证（ModelSim 10.6c 实跑, ALL TESTS PASSED）

- T1 (ε=+0.3, SNR 20dB)：粗 CFO 误差 **0.0021**；`n_fine=242` = 浮点全精度
  参考 = 真值（**0 样点误差**）；直通段 ±8 LSB；校正后 T1 相位集中度 0.996。
- T2 (复位重入, ε=-0.2)：误差 0.0025，其余同判据全过。
- T3 (50% 间隙流)：与背靠背逐项一致（拍域不变性）。
- 排障记录：X 灌累加器（流水填充竞态，S2 加复位）、部分窗口噪声假平顶
  （判决满窗门控 m≥48）、T2 错锁 +64（防错锁回查）——均实测定位实测修复。

## [0.1.0] — 2026-07-28 hdl-coding 规范整改

按 `docs/rules/01-hdl.md` 五条红线整改全部 RTL。**只动编码规范层面**；
算法/数值层面的遗留缺陷未改，逐条列在 README「遗留缺陷」表。

### 变更

- 复位：`negedge rst_n` 异步低有效 → 同步高有效 `i_rst`；此前多个
  `always_ff` 完全无复位，已全部补齐。
- 命名：`clk/rst_n` → `i_clk/i_rst`；非 AXI 端口补 `i_`/`o_` 前缀；
  内部信号改 `ri_/ro_/r_/w_`；FSM 状态改 `P_` 前缀。
- 红线 1：`packet_detect` / `fine_timing` / `cordic_core` / `sync_top`
  新增 `ri_` 输入寄存级。
- 红线 2：`m_axis`、`o_sync_locked`、`o_metric_*` 改由 `ro_` 寄存器驱动。
- 红线 4：`sync_top` FSM 由二段式改三段式并补 `default`。
- `fine_timing`：删除一个只有注释的空 `always_ff` 死块。

### 接口/延迟契约变化（使用方必读）

- `sync_top` 的 `m_axis` 相对 `s_axis` 由 0 拍变 **2 拍**
- `packet_detect` 输入到 `o_metric_valid` 由 5 拍变 **6 拍**
- `fine_timing` 全链整体后移 1 拍（数值不变）
- `cordic_core` 由 `STAGES+1` 拍变 **`STAGES+2`** 拍

### 整改中发现的致命缺陷（已消除）

**`packet_detect` 此前处于永久 X 锁死状态，从未检出过任何包。**
`p_i`/`p_q` 无复位，上电为 X；累加器自反馈 `acc_i <= acc_i + p_i - pd_i[L_CORR]`，
第一个 `tvalid` 拍就把 X 吸进 `acc_i` 且永远出不去 → `c2` 恒 X → 判定恒假。
已用对拍 TB 取证（旧版 `acc_i=xxxxxxxx`，整改版同时刻为确定值）。

### 验证

- `tb_sync_top`：包检测在 CFO=0.3 / CFO=-1.2 两种条件下均置位；
  `m_axis == s_axis` 延迟 2 拍逐位一致（768 拍）；`o_fft_start` 检查标记为
  xfail（对应遗留缺陷 F3）。
- 模块级性质 TB：整改版复位后全程无 X、对周期输入 100% 响应、复位可重入。
- gate-runner：`G-A-00/G-A-01/G-A-02/G-A-04/G-C-03/RL-OUT` 全绿。
