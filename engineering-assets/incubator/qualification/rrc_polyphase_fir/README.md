<!-- 级别横幅（由成熟度派生）: INCUBATOR / QUALIFICATION — 未认证，勿在生产设计中直接复用 -->

# rrc_polyphase_fir

> `asset_uid: rrc_polyphase_fir` · `version: 0.1.0` · `owner: lihan`
> 成熟度: **qualification（孵化中）** — 见 `../../../var/gates/pg/rrc_polyphase_fir/gate-results.json`

## 用途

RRC（根升余弦）脉冲成形多相 FIR 滤波器核。33 抽头（α=0.5, sps=4, span=8）4 相多相插值，每相 9 抽头直算（相 1–3 零补齐），符号率输入、4× 采样率输出。系数取自 golden `rrc_coeff.hex`（Q1.15）；舍入/饱和与 golden 定点语义逐位一致（round-half-away /2^15，对称裁剪 ±32767）。

**bit-true 已验证**：ModelSim cosim 2048 样点 0 失配（流水偏移 16 = 4 符号群延迟）。
**约束**：输入符号间隔 ≥ 4 拍（`s_axis_tready` 恒 1，无内部背压缓冲）；`m_axis_tready` 不参与内部节流。
**修复史（0.3.0）**：原实现系数表与 golden 不符、且相 1–3 采用数学上不成立的对称折叠（33 抽头 RRC 仅相 0 自对称）——由 cosim 门禁捕获后重写。

## 接口（manifest 派生视图，勿手改）

| 端口 | 方向 | 位宽 | 协议 |
|---|---|---|---|
| clk | input | 1 | — |
| rst_n | input | 1 | — |
| s_axis_tvalid / s_axis_tready / s_axis_tdata | in/out/in | 1/1/32 | AXI4-Stream |
| m_axis_tvalid / m_axis_tready / m_axis_tdata | out/in/out | 1/1/32 | AXI4-Stream |

## 参数

| 参数 | 值 | 说明 |
|---|---|---|
| DATA_W | 16 | I/Q 各 16 bit（Q1.15） |
| SPS | 4 | 每符号采样数（多相相数） |
| SPAN | 8 | 滤波器符号跨度 |

## 反偏离锚链

- 需求/算法: `engineering-assets/knowledge/primary/domains/comm/rrc/algorithm_spec.md`
- 定点报告: `engineering-assets/knowledge/primary/domains/comm/rrc/fixed_point_report.md`
- Golden 模型: `model_comm_rrc`（**待纳入 models/ 治理**）

## 已知限制 / 认证阻塞

由门禁 runner 判定（见 gate-results.json）。当前 **未达 certified**：需先修复红线类阻塞（命名 `i_clk/i_rst`、同步高有效复位、输出寄存、去 `initial`），并接入 golden bit-true 对标。
