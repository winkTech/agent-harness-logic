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
| clk | input | 1 | — |
| rst_n | input | 1 | —（异步低有效） |
| s_axis_tvalid / s_axis_tready / s_axis_tdata | in/out/in | 1/1/32 | AXI4-Stream（Y from FFT, Q2.14 {Q,I}） |
| m_axis_tvalid / m_axis_tready / m_axis_tdata | out/in/out | 1/1/32 | AXI4-Stream（H_est to EQ, Q2.14 {Q,I}） |

## 参数

| 参数 | 值 | 说明 |
|---|---|---|
| DATA_W | 16 | I/Q 各 16 bit（Q2.14） |
| N_FFT | 64 | FFT 点数（ls_estimator/channel_interpolator） |
| N_PILOT | 4 | 导频数 |

## 反偏离锚链

- 需求/算法: `knowledge/primary/domains/comm/channel_est/algorithm_spec.md`
- 定点报告: `knowledge/primary/domains/comm/channel_est/fixed_point_report.md`
- 实现报告: `knowledge/primary/domains/comm/channel_est/report_channel_est_fpga_implementation.md`
- 资源估算: `knowledge/primary/domains/comm/channel_est/resource_estimate.md`
- Golden 模型: `model_comm_channel_est`（已迁入 `engineering-assets/models/comm/channel_est/`）

## 已知红线违规（评估性打包，如实记录，未修复）

1. **红线1（ri_ 输入寄存）**：三个模块的输入均未经 `ri_` 寄存直接消费（如 `ls_estimator.sv` 中 `s_axis_tdata` 直接进入捕获逻辑）。
2. **红线2（ro_ 输出寄存）**：组合直出——`ls_estimator.sv:123-125`（`s_axis_tready`/`pilot_valid`/`symbol_done` 均 assign 组合）、`channel_interpolator.sv:124-125`（`m_axis_tvalid`、`m_axis_tdata={out_q,out_i}` 由 always_comb 结果直出）。
3. **红线3（同步高有效复位）**：全部使用 `rst_n` 异步低有效（`negedge rst_n`），无同步释放；`channel_interpolator.sv:44,53` 两个 always_ff 完全无复位。
4. **红线4（三段式 FSM + default）**：`ls_estimator.sv:96-111`、`channel_est_top.sv:61-68` 的 FSM case 无 `default` 分支；`channel_interpolator.sv:109-117` 用 `unique case` 无 default。
5. **红线5（无锁存器）**：未发现锁存器（always_comb 均有前置默认赋值）。
6. 命名规范：`clk`/`rst_n` 应为 `i_clk`/`i_rst`；内部信号无 `r_`/`w_` 前缀（AXI 信号协议豁免）。

## 其他评估发现

- `channel_est_top.sv:93` 跨层级引用 `u_interpolator.m_axis_tvalid`（综合不友好）。
- `tb/tb_channel_est_top.sv` 自检 TB 有缺陷：`send_sym` 用 `$shortrealtobits` 打包 IEEE-754 浮点位型而非 Q2.14 定点（激励错误）；`check_h` 连续多点检查间不推进时钟，全部采样同一拍数据。
- `tb/tb_chEst_cosim.sv` 依赖 `rx_chEst.bin`/`expected_chEst.bin` 黄金向量，**向量文件从未导出入库**，cosim 当前不可运行（G-B-03 blocked）。
- `tb/uvm/` UVM 环境引用 `../../../../../docs/templates/uvm/*.sv` 模板库，该目录在仓库中**不存在**，UVM TB 按原样不可编译。

## 已知限制 / 认证阻塞

由门禁 runner 判定（见 gate-results.json）。当前 **未达 qualification**：需修复红线类阻塞（命名 `i_clk/i_rst`、同步高有效复位、输出寄存、FSM default），生成黄金向量并接入 bit-true 对标。
