<!-- 级别横幅（由成熟度派生）: INCUBATOR / INTAKE — 未认证，勿在生产设计中直接复用 -->

# channel_est_top

> `asset_uid: channel_est_top` · `version: 0.2.0` · `owner: lihan`
> 成熟度: **intake（评估性打包）** — 见 `../../../var/gates/pg/channel_est_top/gate-results.json`

## 用途

802.11a OFDM 信道估计核，估计基础为 **长训练符号 LS + 导频公共相位跟踪**
（ADR-002 裁决，2026-07-31 架构重排）：

- 每帧 = 2×LTS + N 个数据符号（均为 FFT 输出，64 子载波/符号，Q2.14）；
- LTS 阶段：全用载波 LS —— `H_LTS[k] = ((X_lts·Y1 + X_lts·Y2 + 1) >>> 1)`
  （X_lts ∈ {±1,0}，除法退化为符号翻转），保护带/DC 恒 +1.0；
- 数据符号阶段：4 导频（{-21,-7,7,21}，极性 [1,1,-1,1]）估计公共相位
  `CPE = angle(Σ Y[p]·conj(H_LTS[p])·pilot[p])`（CORDIC 14 迭代），
  输出 `H(m) = H_LTS · e^{j·CPE(m)}`（逐点复乘 + round + 饱和）；
- LTS 符号不产生输出；每个数据符号输出 64 点。

层级：`channel_est_top`（帧定序）→ `lts_estimator`（LTS 累加 + H_LTS RAM）
+ `cpe_tracker`（导频积 + CPE 计算 + 校正输出）→ `cordic_cv`（向量/旋转双模）。

## 接口（manifest 派生视图，勿手改）

| 端口 | 方向 | 位宽 | 协议 |
|---|---|---|---|
| i_clk | input | 1 | — |
| i_rst | input | 1 | —（**同步复位，高有效**） |
| i_frame_start | input | 1 | 侧带脉冲：标记其后首个符号为 LTS1，**须领先首个 LTS 样点 ≥1 拍**（风格同 `sync_top.o_fft_start`） |
| s_axis_tvalid / s_axis_tready / s_axis_tdata | in/out/in | 1/1/32 | AXI4-Stream（Y from FFT, Q2.14 {Q,I}） |
| m_axis_tvalid / m_axis_tready / m_axis_tdata | out/in/out | 1/1/32 | AXI4-Stream（H(m) to EQ, Q2.14 {Q,I}） |

节流语义（`s_axis_tready` 拉低，AXIS 合法，上游须容忍）：
帧起始待决而计算/输出级未排空时；数据符号末 3 拍且上一符号 CPE 链未闲时。

## 参数

| 参数 | 值 | 说明 |
|---|---|---|
| DATA_W | 16 | I/Q 各 16 bit（Q2.14） |
| N_FFT | 64 | 设计常量（含 `P_IDX_W=6` 派生参数） |
| N_PILOT | 4 | 设计常量；ADR-002 后导频仅作 CPE 跟踪 |

## 反偏离锚链

- 需求/算法: `engineering-assets/knowledge/primary/domains/comm/channel_est/algorithm_spec.md`（§2.2 已按 ADR-002 修订）
- 架构裁决: `engineering-assets/docs/governance/adr/ADR-002-channel-est-estimation-basis.md`
- Golden 模型: `model_comm_channel_est` 1.1.0（`run_all_tests` 7/7，2026-07-31）
- 定点/实现/资源三份历史报告仍锚定旧插值架构，**待随 qualification 阶段修订**

## 验证现状（2026-07-31 架构重排后，全部实跑取证）

- **定向自检 TB**（`tb/tb_channel_est_top.sv`，ModelSim 10.6c）：
  T1 平坦信道 / T2 变化复信道 + 逐符号 CPE(±0.3/-0.2 rad) + 数据内容无关性 /
  T3 随机反压逐点一致 / T4 半帧重启 / T5 帧中复位恢复 / T6 背靠背 + 延迟实测
  —— **ALL TESTS PASSED**，判据解析期望 ±12 LSB，实测延迟 **111 拍**（< 400）。
- **Vivado 2023.1.1 OOC**（xc7k325t，`var_build/vivado/rpt/flow_summary.json`）：
  rtlcheck 0 违例；synth **WNS +4.673 ns @10 ns**（≈187 MHz）；
  **LUT 749 / FF 610 / BRAM 1 / DSP 8**（预算 <20，导频积 4 + 旋转 4，推断符合设计）；
  CDC critical 0。
- **cosim（G-B-03）**：`tb/tb_chEst_cosim.sv` 已改造为帧级 **0 容差逐字比对**；
  等待 `generate_vectors.m` 位真镜像改造（models/ 受保护树）导出
  `rx_chEst_frame.hex` / `expected_chEst_frame.hex` 后可跑。
- `tb/uvm/` 仍引用断链的模板路径，按原样不可编译（遗留，不在本次验证面内）。

## 已知限制 / 认证阻塞

- **G-B-03 bit-true 对标**：待 `generate_vectors.m` 帧级位真镜像 + 向量导出
  （旧 `rx_chEst.bin`/`expected_chEst.bin` 单符号向量语义已作废）。
- 定点语义镜像约定：RTL（`lts_estimator`/`cpe_tracker`/`cordic_cv` 头注释）与
  `generate_vectors.m` 必须逐字同步，任何一侧改动定点语义都要同步另一侧。
- UVM 环境断链（承自 0.1.0）。
- G-A-04（qualification）：`cpe_tracker.sv` 372 行 > 300，待 qualification
  推进时拆分或按白名单处理。
- 导频极性为固定 [1,1,-1,1]（golden `sim_frame.m` 契约）；802.11a 逐符号导频
  扰码未建模，golden 升级时需同步（需求门禁 D6 已记录）。

## 0.1.0 历史缺陷的归宿

0.1.0 README 所列遗留缺陷（导频极性表硬编码、斜率定点标定、累加器溢出、
`interp_busy` 自指、无双缓冲、`o_pilot_valid` 未用）全部随插值数据通路
（`ls_estimator`/`channel_interpolator`）的整体替换而消灭，不再逐条修补；
0.1.0 修复的两个致命缺陷（计数差一、导频计数不清零）在新架构中以
帧定序 + 逐符号 S 清零的结构性方式覆盖（TB T2/T6 多符号场景验证）。
