# sync_top — OFDM 同步顶层 (802.11a) [intake]

RTL 源码原从 `engineering-assets/knowledge/primary/domains/comm/synch/` 迁入。
**2026-07-28 已按 `docs/rules/01-hdl.md` 五条红线整改**，本 README 同步更新为整改后现状。
整改只动编码规范层面；算法/数值层面的遗留缺陷**未改**，逐条列在下方"遗留缺陷"一节。

## 功能

802.11a OFDM 突发同步链：短前导码滑窗自相关包检测 → 长前导码互相关精定时 →
FFT 窗口触发。AXI4-Stream 输入/输出（`m_axis` 当前为直通占位，CFO 校正未接入，
`cordic_core` 已实现但未在 `sync_top` 中例化）。

## 包结构

```
manifest.json          CBB manifest (已更新: i_clk/i_rst 同步高有效)
run_sim.do             原 ModelSim 仿真脚本 (来自 rtl/sim/)
rtl/
  sync_pkg.sv          常量包 (N_FFT/N_SHORT/CORDIC 参数; 无模块引用它)
  packet_detect.sv     短前导码滑窗自相关包检测
  fine_timing.sv       长前导码 64 抽头互相关精定时
  cordic_core.sv       流水线 CORDIC (vector/rotation 双模; 顶层未例化, 孤立模块)
  sync_top.sv          顶层: packet_detect + fine_timing + 三段式 FSM + AXI 直通
tb/
  tb_sync_top.sv       过程式 TB: 自生成 preamble+CFO+AWGN
  uvm/                 UVM 环境 (pkg/sequences/scoreboard/base+basic test/top + compile.tcl)
```

## 顶层接口 (sync_top, DATA_W=16)

| 端口 | 方向 | 宽度 | 说明 |
|:-----|:-----|:----:|:-----|
| i_clk | in | 1 | 时钟 (TB 10ns → 100MHz) |
| i_rst | in | 1 | **同步复位，高有效** |
| s_axis_t{valid,ready,data} | AXI-S slave | 1/1/32 | 输入样本 {Q[15:0], I[15:0]} Q2.14 |
| m_axis_t{valid,ready,data} | AXI-S master | 1/1/32 | 输出 = 输入延迟 2 拍 (CFO 校正占位); tready 未使用 |
| o_fft_start | out | 1 | FFT 窗口触发 |
| o_sync_locked | out | 1 | FSM 处于 TRACK |

## 红线整改结果

| 红线 | 整改前 | 整改后 |
|:-----|:-------|:-------|
| 1 输入寄存 `ri_` | 全部模块输入直通使用 | 各模块新增 `ri_` 输入寄存级；顶层数据通路经 `ri_`/`ro_` |
| 2 输出寄存 `ro_` | `m_axis`/`sync_locked`/`metric_*` 组合直出 | 全部输出由 `ro_` 寄存器驱动 |
| 3 同步复位 `i_rst` | `negedge rst_n` 异步低有效，且多个 always_ff 完全无复位 | 全部改同步高有效 `i_rst`，无复位寄存器全部补齐 |
| 4 三段式 FSM | `sync_top` 二段式，case 无 `default` | 改三段式（次态组合 / 状态寄存 / 输出寄存），补 `default` |
| 5 无锁存器 | 未见违规 | 保持；`always_comb` 均有前置默认赋值 |
| 命名 | `clk/rst_n`，非 AXI 端口缺前缀 | `i_clk/i_rst`，全部非 AXI 端口带 `i_`/`o_`，内部用 `ri_/ro_/r_/w_`，状态用 `P_` |

**延迟契约变化**（整改副作用，使用方必须知道）：

- `sync_top` 的 `m_axis` 相对 `s_axis` 由 0 拍变 **2 拍**（新增 `ri_` + `ro_` 两级）
- `packet_detect` 输入到 `o_metric_valid` 由 5 拍变 **6 拍**
- `fine_timing` 全链整体后移 1 拍（数值不变）
- `cordic_core` 由 STAGES+1 拍变 **STAGES+2 拍**（新增 `ro_` 输出寄存）

## 整改中发现的致命缺陷（已消除）

**`packet_detect` 修复前处于永久 X 锁死状态，从未检出过任何包。**

`p_i`/`p_q` 两个乘积寄存器没有复位，上电为 X；累加器是自反馈的
`acc_i <= acc_i + p_i - pd_i[L_CORR]`，第一个 `tvalid` 拍就把 X 吸进 `acc_i`，
此后 X 永远出不去 → `c2` 恒为 X → 判定条件恒为 X（被当假）→ 输出恒 0。

已用对拍 TB 取证：同一激励下旧版 `acc_i=xxxxxxxx`，整改版为确定值。
这正是红线 3 "必须有同步复位" 要防的事故类型。

## 已知限制与验证边界（遗留缺陷，本次**未改**，需算法/数值决策）

| 编号 | 位置 | 问题 |
|:-----|:-----|:-----|
| F1 | `packet_detect.sv` | **门限溢出**：`se=(TH_Q·E)²` 后 `>>>30`，意图是 `E²/4`，但中间量 `2^28·E²` 溢出 64 位（噪声下 E≈2²³ → 2⁷⁵）。实测**噪声虚警率 99%**，检测器无判别力。此缺陷此前被 X 锁死掩盖。修它须重定标整条定点链并权衡乘法器面积。 |
| F2 | `packet_detect.sv` | `acc_i/acc_q/energy` 均 32 位，但 16 点滑窗累加 16 个最大 2³¹ 的项需 ~36 位，存在静默溢出。 |
| F3 | `fine_timing.sv` | **`o_fft_window_start` 恒为 0** —— 没有任何路径把它置 1，FFT 窗触发未实现。因此 `sync_top` 的 DETECT→TRACK 永不发生，`o_sync_locked` 恒 0。 |
| F4 | `fine_timing.sv` | 相关和只累加实部 `mul_i`，丢弃 `mul_q`，比的不是相关幅度，对载波相位敏感。 |
| F5 | `fine_timing.sv` | 峰值用有符号比较而非取模，负相关峰漏检；`o_timing_offset` 有未补偿的固定流水偏移。 |
| F6 | `cordic_core.sv` | vector 模式只更新 `phase_pipe`、rotation 模式只更新 `z_pipe`，未被赋值的一路不随流水搬移，停在残值。另 `ANG` 表固定 12 项但 `STAGES` 可配。 |
| F7 | `sync_top.sv` | CFO 估计/校正未实现（数据通路是直通占位）；`m_axis_tready` 未使用，下游反压会丢样点。 |

## Golden Model

- 位于 `engineering-assets/models/comm/synch/` (`model_comm_synch`)，.m 未改动。
- Golden 为纯浮点链，唯一定点环节是 `src/generate_vectors.m` 的 Q2.14 量化导出。
- **向量健康度**：仓库内不存在任何已导出的 expected/stimulus 向量文件
  （`generate_vectors.m` 的输出 `../vectors/expected_sync_out.bin` 从未入库），
  bit-true 对标缺激励与期望，需先用 MATLAB 跑 `run_synch_sim.m` + `generate_vectors.m`。
- RTL 与 golden 的结构性偏差：RTL 缺 CFO 估计/校正数据通路（见 F7），fidelity 仍为 `pending`。

## 验证现状

- `tb/tb_sync_top.sv`：随整改同步更新（端口名 + 复位极性），并**新增了真实断言**：
  - 短前导码期间 `packet_detect` 必须置位 —— 两种 CFO 下均 PASS；
  - `m_axis == s_axis` 延迟 2 拍逐位一致 —— 768 拍 PASS；
  - `o_fft_start` 置位检查保留但标记为 **xfail**（对应遗留缺陷 F3）。
  原 TB 只断言 `o_fft_start`，而该信号因 F3 恒为 0，等于既测不出通过也测不出回归。
- 模块级性质 TB（scratchpad，未入库）另验证了：整改版复位后全程无 X、
  对周期输入 100% 响应、复位可重入；并取证了旧版的 X 锁死。
- `tb/uvm/`：UVM 环境仍**不可运行** —— `sync_uvm_pkg.sv` 的相对 include 路径
  在本包内断链，且 `sync_scoreboard` 依赖从未生成的 `expected_sync_out.bin`。
  本包门禁 (G-A-00) 只编译 role=rtl，不编译 UVM TB。
- **未验证项**：资源/Fmax/时序/可综合性均未跑 Vivado，无报告支撑。
