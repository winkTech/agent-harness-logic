# sync_top — OFDM 同步顶层 (802.11a) [intake]

评估性打包：RTL 源码从 `engineering-assets/knowledge/primary/domains/comm/synch/` **原样迁入，未做任何修改**。
本 README 如实记录现状，包括红线违规与编译级缺陷——它们是评估结论，不在 intake 阶段修复。

## 功能

802.11a OFDM 突发同步链：短前导码滑窗自相关包检测 → 长前导码互相关精定时 →
FFT 窗口触发。AXI4-Stream 输入/输出（`m_axis` 当前为直通占位，CFO 校正未接入，
`cordic_core` 已实现但未在 `sync_top` 中例化）。

## 包结构

```
manifest.json          CBB manifest (如实声明: rst_n 异步低有效等)
run_sim.do             原 ModelSim 仿真脚本 (来自 rtl/sim/)
rtl/
  sync_pkg.sv          常量包 (N_FFT/N_SHORT/CORDIC 参数; 无模块引用它)
  packet_detect.sv     短前导码滑窗自相关包检测
  fine_timing.sv       长前导码 64 抽头互相关精定时 (含编译级缺陷, 见下)
  cordic_core.sv       流水线 CORDIC (vector/rotation 双模; 顶层未例化, 孤立模块)
  sync_top.sv          顶层: packet_detect + fine_timing + FSM + AXI 直通
tb/
  tb_sync_top.sv       过程式 TB: 自生成 preamble+CFO+AWGN, 仅检查 fft_start 置位
  uvm/                 UVM 环境 (pkg/sequences/scoreboard/base+basic test/top + compile.tcl)
```

## 顶层接口 (sync_top, DATA_W=16)

| 端口 | 方向 | 宽度 | 说明 |
|:-----|:-----|:----:|:-----|
| clk | in | 1 | 时钟 (TB 10ns → 100MHz) |
| rst_n | in | 1 | **异步低有效**，无同步释放 |
| s_axis_t{valid,ready,data} | AXI-S slave | 1/1/32 | 输入样本 {Q[15:0], I[15:0]} Q2.14 |
| m_axis_t{valid,ready,data} | AXI-S master | 1/1/32 | 输出 = 输入直通 (CFO 校正占位); tready 未使用 |
| fft_start | out | 1 | FFT 窗口触发 |
| sync_locked | out | 1 | FSM 处于 TRACK |

## 红线违规清单 (如实记录, 未修复)

1. **红线1 输入未寄存 (ri_)**：全部模块输入未经 `ri_` 寄存直接使用；
   `sync_top.sv:86-87` 输入 `s_axis_tvalid/tdata` 直通到输出；
   `packet_detect.sv:117` `metric_valid = s_axis_tvalid` 直通。
2. **红线2 输出组合直出 (ro_)**：`sync_top.sv:86-87` (`m_axis_tvalid/tdata` assign 直通)、
   `sync_top.sv:106` (`sync_locked` 组合比较直出)、`packet_detect.sv:116-118`
   (`metric_q15/metric_valid/s_axis_tready` assign 直出)、`cordic_core.sv:93-96`
   (输出为寄存器别名 assign，未走 `ro_`)。
3. **红线3 复位**：全库使用 `negedge rst_n` 异步低有效（`sync_top.sv:64,101`、
   `packet_detect.sv:29,59,76,101`、`fine_timing.sv:49,98`、`cordic_core.sv:37`），
   无同步释放电路；另有多个 always_ff 完全无复位
   (`packet_detect.sv:46,95,110`、`fine_timing.sv:68,81,109`、`cordic_core.sv:59`)。
4. **红线4 FSM**：`sync_top.sv:92-104` 为二段式 FSM（非三段式），case 无 `default` 分支。
5. **红线5 锁存器**：未见组合 latch（always_comb 均有前置默认赋值）。
6. **命名**：`clk/rst_n` 非 `i_clk/i_rst`；非 AXI 端口普遍缺 `i_/o_` 前缀
   (`fft_start`、`sync_locked`、`enable`、`packet_detected`、`metric_*`、
   `start/mode/xi/yi/phi/done/xo/yo/phase_o` 等)；内部信号未用 `r_/w_` 体系
   (fine_timing 部分用了 `r_` 前缀，其余模块没有)。

## 编译级缺陷 (fine_timing.sv, 预期 vlog FAIL)

- `fine_timing.sv:95`：`corr_t'` 类型转换 — `corr_t` 在任何文件中都未定义 (sync_pkg 也没有)。
- `fine_timing.sv:110`：`rst_n_sync` 未声明；且 `if (rst_n_sync)` 进入的是复位分支，
  极性疑似写反（高电平复位一个名为 *_n_sync 的信号）。
- `fine_timing.sv:81-85`：空 always_ff（只有注释的死块）。

## Golden Model

- 已迁移至 `engineering-assets/models/comm/synch/` (`model_comm_synch`)，.m 未改动。
- Golden 为纯浮点链 (packet_detect/coarse_cfo/fine_cfo/cfo_correct/fine_timing)，
  唯一定点环节是 `src/generate_vectors.m` 的 Q2.14 量化导出。
- **向量健康度**：仓库内不存在任何已导出的 expected/stimulus 向量文件
  （`generate_vectors.m` 的输出 `../vectors/expected_sync_out.bin` 从未入库），
  无常量轨/损坏问题可查，因为根本没有向量；bit-true 对标缺激励与期望，
  需先用 MATLAB 跑 `run_synch_sim.m` + `generate_vectors.m` 生成。
- RTL 与 golden 的结构性偏差：RTL 缺 CFO 估计/校正数据通路（golden 有
  coarse/fine CFO + correct，RTL 仅有孤立 cordic_core），fidelity 只能是 `pending`。

## TB 现状

- `tb/tb_sync_top.sv`：过程式自生成激励（简化 T1 用冲激近似, 非真实 802.11a 长前导码），
  仅断言 `fft_start` 置位，无数据通路比对，无背压/复位中途场景。
- `tb/uvm/`：UVM 环境。`sync_uvm_pkg.sv` 通过相对路径
  `../../../../../docs/templates/uvm/*.sv` `include` 共享模板
  (原位解析到 `knowledge/docs/templates/uvm/`，**在本包内该相对路径断链**，
  评估性打包不改源码，故未修复；编译 UVM TB 需在原位或加 `+incdir` 指向模板目录)。
  `sync_scoreboard` 期望逐样点比对 `expected_sync_out.bin`——该 golden 向量文件
  从未生成，UVM 比对当前不可运行。本包门禁 (G-A-00) 只编译 role=rtl，不编译 TB。
