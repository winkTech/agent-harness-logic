<!-- 级别横幅（由成熟度派生）: INCUBATOR / INTAKE — 未认证，勿在生产设计中直接复用 -->

# channel_est_top

> `asset_uid: channel_est_top` · `version: 0.1.0` · `owner: lihan`
> 成熟度: **intake（评估性打包）** — 见 `../../../var/gates/pg/channel_est_top/gate-results.json`

## 用途

802.11a OFDM 信道估计核：从 FFT 输出 (64 子载波/符号) 中按导频位置 {11,25,39,53}（对应子载波 -21/-7/7/21）提取 4 个 BPSK 导频，LS 估计（符号选择：导频 2 为 -1 取反），随后线性插值到全部 64 个子载波输出 H_est。三段流水：捕获(64 clk) + 斜率计算(3 clk) + 输出(64 clk)，符号级流水化，标称延迟 131 clk @ 100 MHz。

层级：`channel_est_top`（顶层）→ `ls_estimator`（导频提取/LS）+ `channel_interpolator`（线性插值）。

## 接口（manifest 派生视图，勿手改）

| 端口 | 方向 | 位宽 | 协议 |
|---|---|---|---|
| i_clk | input | 1 | — |
| i_rst | input | 1 | —（**同步复位，高有效**） |
| s_axis_tvalid / s_axis_tready / s_axis_tdata | in/out/in | 1/1/32 | AXI4-Stream（Y from FFT, Q2.14 {Q,I}） |
| m_axis_tvalid / m_axis_tready / m_axis_tdata | out/in/out | 1/1/32 | AXI4-Stream（H_est to EQ, Q2.14 {Q,I}） |

## 参数

| 参数 | 值 | 说明 |
|---|---|---|
| DATA_W | 16 | I/Q 各 16 bit（Q2.14） |
| N_FFT | 64 | FFT 点数（ls_estimator/channel_interpolator） |
| N_PILOT | 4 | 导频数 |

## 反偏离锚链

- 需求/算法: `engineering-assets/knowledge/primary/domains/comm/channel_est/algorithm_spec.md`
- 定点报告: `engineering-assets/knowledge/primary/domains/comm/channel_est/fixed_point_report.md`
- 实现报告: `engineering-assets/knowledge/primary/domains/comm/channel_est/report_channel_est_fpga_implementation.md`
- 资源估算: `engineering-assets/knowledge/primary/domains/comm/channel_est/resource_estimate.md`
- Golden 模型: `model_comm_channel_est`（已迁入 `engineering-assets/models/comm/channel_est/`）

## 红线整改结果（2026-07-28）

| 红线 | 整改前 | 整改后 |
|:-----|:-------|:-------|
| 1 输入寄存 `ri_` | 三个模块输入均直接消费 | `ls_estimator` 新增 `ri_` 输入寄存级 |
| 2 输出寄存 `ro_` | `s_axis_tready`/`pilot_valid`/`symbol_done`/`m_axis_*` 全部组合直出 | 全部由 `ro_` 寄存器驱动；插值器输出级与累加器共用统一使能，反压时整体冻结 |
| 3 同步复位 `i_rst` | 全部 `negedge rst_n` 异步低有效；`channel_interpolator` 两个 `always_ff` 完全无复位 | 全部同步高有效 `i_rst`，无复位块已补齐 |
| 4 三段式 FSM | 三个 FSM 均缺 `default` | 均改三段式并补 `default` |
| 5 无锁存器 | 未发现违规 | 保持 |
| §5 位宽 | `sub_idx` 声明 `[N_FFT-1:0]`=64 位、`pilot_cnt` 声明 `[N_PILOT-1:0]`=4 位（把计数上限误当位宽） | 改为 `$clog2` 推导的 6 位 / 3 位，并加数组索引范围保护 |
| 命名 | `clk`/`rst_n`、非 AXI 输出无前缀、内部无 `r_`/`w_` | `i_clk`/`i_rst`、`o_*`、内部 `ri_/ro_/r_/w_`、状态 `P_` |
| 封装 | `channel_est_top.sv:93` 跨层级引用 `u_interpolator.m_axis_tvalid` | 改用顶层端口信号，无跨层次引用 |

## 整改中发现并修复的两个致命功能缺陷

这两项**不是编码规范问题**，但它们让整个信道估计链从未产出过任何结果，
不修就无法做任何验证，因此一并修复并在此明确记录：

1. **子载波计数差一** —— `ls_estimator` 原先只在 `state == CAPTURE && 握手` 时计数，
   而 `IDLE→CAPTURE` 恰好由第一个握手拍触发，**第一拍不计数**。64 拍激励下
   `sub_idx` 最多到 62，`sub_idx == N_FFT-1` 永不成立，状态机出不了 CAPTURE，
   `o_symbol_done` 从未置位过。
2. **导频计数不按符号清零** —— `pilot_cnt` 原先只有复位才清零，第一个符号抓满
   4 个导频后停在 4，之后所有符号的导频写入全部越界被丢弃。

这两项此前一直没暴露，是因为原 TB 用裸 `#5000` 延时后直接读 `m_axis_tdata`
（读到的是残留值），从未按握手捕获整个符号再比对。

## 验证现状

- `tb/tb_channel_est_top.sv` 随整改更新并修好了三处 TB 自身缺陷：
  - 激励量化：原用 `$shortrealtobits(v*16384.0)` —— 该函数返回 IEEE-754 单精度
    **位模式**而非定点整数，送进 DUT 的是无意义比特，而 `check_h` 却按 Q2.14 整数
    解释。现改为 `$rtoi` 取整并做饱和。
  - 输出采样：原用裸延时后直接读端口，`check_h` 的 `idx` 参数从未真正参与索引。
    现按 `m_axis_tvalid` 握手捕获整个符号后再逐点比对。
  - 失败退出：补 `$fatal`，原实现失败也退出 0。
- **实测结果（ModelSim 10.6c）**：Test 1 平坦信道 H=1、Test 2 复常数信道 0.5+0.5j，
  两个符号各 **64/64 子载波全部捕获**，抽查的 5 个子载波（含 DC）全部在 ±3 LSB 内，
  `ALL TESTS PASSED`。这是本包第一次跑出端到端有效结果。
- `tb/tb_chEst_cosim.sv` 已同步更新端口名并编译通过，但仍依赖
  `rx_chEst.bin`/`expected_chEst.bin` 黄金向量，**向量文件从未导出入库**，
  cosim 仍不可运行（G-B-03 blocked）。
- `tb/uvm/` UVM 环境引用 `../../../../../docs/templates/uvm/*.sv`，该相对路径在本包内
  断链，UVM TB 按原样仍不可编译。
- **未验证项**：资源 / Fmax / 时序 / 可综合性均未跑 Vivado，无报告支撑。

## 遗留缺陷（本次未改）

- `ls_estimator`：导频极性表硬编码为"只有第 3 个导频取负"，与 802.11a 按符号序号
  变化的导频扰码序列不符。
- `channel_interpolator`：斜率定点标定（`prod[29:14]` 切片 + bit13 舍入）与 `DATA_W`
  的关系是硬编码的，`DATA_W != 16` 时不成立；累加器 `DATA_W` 位强制截断，多次累加
  可能溢出且无饱和保护。
- `channel_est_top`：流水控制 FSM 的 `interp_busy` 定义自指；文件头注释宣称的
  "抓取当前符号时处理上一符号"乒乓流水在代码里没有对应的双缓冲结构；
  `o_pilot_valid` 未被顶层使用，插值器直接读导频寄存器，无显式握手保护。

## 已知限制 / 认证阻塞

由门禁 runner 判定（见 gate-results.json）。红线类阻塞已清；
仍缺 **bit-true 对标所需的黄金向量**（G-B-03）与具名签字（G-SIGN-01）。
