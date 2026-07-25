<!-- 级别横幅（由成熟度派生）: INCUBATOR / QUALIFICATION — 未认证，勿在生产设计中直接复用 -->

# rrc_polyphase_fir

> `asset_uid: rrc_polyphase_fir` · `version: 0.3.0` · `owner: lihan`
> 成熟度: **qualification** — 15 道 MUST 门中 14 道已过，仅余 `G-SIGN-01`（具名签字）
> 证据目录: `engineering-assets/var/gates/pg/rrc_polyphase_fir/`（本地生成，见 §6 复现）

RRC（根升余弦）脉冲成形多相 FIR 滤波器核。本包同时作为库内 **CBB 资产的参考样板**：
所有机器门禁的证据均可由 §6 的命令一键重生，文档中每个数字都来自实测而非估算。

---

## 1. 功能与数值契约

33 抽头（α=0.5, sps=4, span=8）4 相多相插值：符号率输入、4× 采样率输出。
每相 9 抽头直算（相 1–3 零补齐 —— 33 抽头 RRC 仅相 0 自对称，不可折叠）。

| 项 | 约定 |
|---|---|
| 系数 | golden `models/comm/rrc/rrc_coeff.hex`，Q1.15 |
| 输入/输出数据 | I/Q 各 16 bit，**Q2.14** |
| 累加器 | 38 bit 全精度，中间无截断 |
| 舍入 | round-half-away-from-zero，`/2^15` |
| 饱和 | 对称裁剪 ±32767 |

**与 golden 逐位一致**（非"容差内接近"）：见 §5。

---

## 2. 接口

模块端口以 RTL 为准，下表与 `rtl/rrc_polyphase_fir.sv` 一致。

| 端口 | 方向 | 位宽 | 说明 |
|---|---|---|---|
| `i_clk` | input | 1 | 时钟 |
| `i_rst` | input | 1 | **同步复位，高有效** |
| `s_axis_tvalid` | input | 1 | AXI4-Stream 从端 |
| `s_axis_tready` | output | 1 | **恒 1**，见 §7 限制 |
| `s_axis_tdata` | input | 32 | `{Q[15:0], I[15:0]}`，Q2.14 |
| `m_axis_tvalid` | output | 1 | AXI4-Stream 主端 |
| `m_axis_tready` | input | 1 | **不参与内部节流**，见 §7 |
| `m_axis_tdata` | output | 32 | `{Q[15:0], I[15:0]}`，Q2.14 |

**延迟 7 拍**：输入寄存 1 + mac / addA / addB / sum / mag / ro 共 6。
输出对齐偏移为 **16 个采样点**（= 4 符号群延迟 × 4 sps），源自 golden 的群延迟裁剪，与 RTL 流水深度无关。

---

## 3. 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `DATA_W` | 16 | I/Q 各自位宽 |
| `COEFF_W` | 16 | 系数位宽（Q1.15） |
| `ACC_W` | 38 | 累加器位宽（容纳 9 项 16×16 乘积和且无截断） |
| `SPS` | 4 | 每符号采样数 = 多相相数 |
| `TAPS_PP` | 9 | 每相抽头数（33 抽头 / 4 相，零补齐） |

当前仅在上述默认值下验证（`manifest.generality.param_space`）。改参数需重跑 §6 全部证据。

---

## 4. 时序与资源包络（实测）

器件 `xc7k325tffg900-2`，**out-of-context** 综合（CBB 是核，不插 I/O 缓冲），Vivado 2023.1.1。

| 项 | 目标/预算 | 实测 | 判定 |
|---|---|---|---|
| 时钟约束 | ≤ 4.000 ns (250 MHz) | 4.000 ns | 约束不松于目标 |
| WNS (setup) | ≥ 0 | **+0.252 ns** | ✅ 0 个失败端点 |
| achieved fmax | ≥ 250 MHz | **266.8 MHz** | ✅ |
| LUT | 2800 | 227 | ✅ |
| FF | 1380 | 254 | ✅ |
| BRAM | 1 | 0 | ✅ |
| DSP | 24 | **24** | ✅ **零裕量**，见 §7 |

> WHS（hold）= −0.163 ns。综合级 hold 为估算值，正常在布局布线阶段收敛；
> 治理规范 G-C-01 的 MVP 判据只取 setup WNS。上板前需以实现后时序为准。

---

## 5. 验证证据

| 门 | 判据 | 结果 |
|---|---|---|
| `G-A-00` | ModelSim `vlog` 编译 | 0 错 0 警 |
| `G-A-01` | 同步高有效复位（红线 3） | 通过 |
| `G-A-02` | 命名规范（AXI 豁免已计） | 通过 |
| `G-A-04` | 模块 ≤300 行 / always ≤50 行 | 通过 |
| `RL-OUT` | 输出由寄存器驱动（红线 2） | 通过 |
| `G-C-03` | 综合源无 `initial` | 通过 |
| `G-B-01/02` | 锚链起点 + golden 受治理 | 通过（`model_comm_rrc`） |
| **`G-B-03`** | **与 golden bit-true** | **2048 样点 / 0 失配**，偏移 16 |
| `G-C-01` | 目标 fmax 收敛 | WNS +0.252 ns |
| `G-C-02` | 资源在包络内 | 4/4 项通过 |
| `CS-1/CS-2` | manifest schema + 源哈希 | 通过 |
| `G-SIGN-01` | 具名签字 | ⛔ **待办**，见 §8 |

**bit-true 的含义与边界**：2048 个采样点上 RTL 输出与 golden 定点模型逐位相同
（16QAM, α=0.5, sps=4 激励）。它**不**覆盖：背压场景、复位中途注入、参数扫描、
以及超出该激励集的边界输入。这些属 `G-C-04/05` 范围，本包尚未提供。

---

## 6. 证据复现

三条命令，顺序执行；产物落在 `engineering-assets/var/gates/pg/rrc_polyphase_fir/`。

```bash
# 1) 综合证据 (timing-summary.rpt / utilization.rpt / synth.log)
cd engineering-assets
node tools/pg-synth.cjs incubator/qualification/rrc_polyphase_fir

# 2) bit-true cosim 证据 (alignment-report.json)
#    -l 显式指定日志: ModelSim 在启动时的 CWD 就建 transcript, 早于 run.do 内的
#    cd, 不指定会在仓库根留下残桩。日志目录须已存在, 故用 var/ 而非其子目录。
vsim -c -l var/rrc-cosim.log \
     -do incubator/qualification/rrc_polyphase_fir/run.do

# 3) 门禁判定 (逐门 pass/fail/blocked + envelope-check.json)
node tools/gate-runner.cjs incubator/qualification/rrc_polyphase_fir --repo-root ..
```

向量由 golden 侧生成，权威位置 `models/comm/rrc/vectors/`（治理规范 §5.5），
经 `+VEC_DIR` 注入 TB —— TB 内不得硬编码路径。

---

## 7. 已知限制

1. **无背压能力**。`s_axis_tready` 恒 1，`m_axis_tready` 不参与内部节流。
   集成方必须保证**输入符号间隔 ≥ 4 拍**，且下游能无条件接收 4× 采样率输出。
   这是本核当前的硬约束，不是可调项。
2. **DSP 零裕量**（24/24）。架构为 9 抽头/相 × I/Q 双路 = 18 个乘法器，
   另 6 个被综合器用作加法树后加器。若需压缩，方向是实现对称折叠
   （设计报告 §5.2 假设的 5 DSP 即基于此，但当前 RTL 未实现）——属架构改动。
3. **hold 未收敛**（综合级 −0.163 ns）。见 §4 注。
4. **仅默认参数经过验证**。见 §3。
5. **缺 G-C-04/05 证据**：复位健壮性、背压、边界/压力/回归尚未提供。
   在这些补齐前，"bit-true" 不等同于"功能完备"。

---

## 8. 认证状态

当前 **QUALIFICATION**。进入 `certified` 只差 `G-SIGN-01` —— 需资产 owner 具名签字。
签字属人工判断，工具不代签。确认 §4/§5 证据与 §7 限制后，在 `manifest.json` 顶层加入：

```json
"signoff": {
  "by": "<签字人姓名>",
  "role": "asset owner",
  "date": "<YYYY-MM-DD>",
  "evidence_reviewed": [
    "var/gates/pg/rrc_polyphase_fir/timing-summary.rpt",
    "var/gates/pg/rrc_polyphase_fir/utilization.rpt",
    "var/gates/pg/rrc_polyphase_fir/alignment-report.json"
  ],
  "accepted_limitations": ["no-backpressure", "dsp-zero-margin", "params-fixed"]
}
```

随后重跑 §6 第 3 条命令确认判定为 `certified`，并把包移入 `certified/`。

---

## 9. 反偏离锚链

| 环节 | 位置 |
|---|---|
| 需求/算法规格 | `knowledge/primary/domains/comm/rrc/algorithm_spec.md` |
| 定点报告 | `knowledge/primary/domains/comm/rrc/fixed_point_report.md` |
| 实现报告 | `knowledge/primary/domains/comm/rrc/report_rrc_fpga_implementation.md` |
| Golden 模型 | `models/comm/rrc/`（受治理资产 `model_comm_rrc`） |
| 本 CBB | 即本目录 |

---

## 10. 修复史

- **0.3.0** — 原实现系数表与 golden 不符，且相 1–3 采用数学上不成立的对称折叠
  （33 抽头 RRC 仅相 0 自对称）。由 cosim 门禁捕获后重写。
- **0.3.0（时序）** — 累加级原为单拍 9 项连加，被综合器映射成 7 级 DSP48 PCOUT
  级联（≈11 ns），WNS −6.211 ns / 实际 ~98 MHz。改为 3 级寄存加法树后瓶颈转移到
  `round_clip`（19 逻辑级 / 15 个 CARRY4 / 4.56 ns），再拆为两级，最终 WNS +0.252 ns。
  代价是延迟由 4 拍增至 7 拍；ACC_W=38 全精度无截断，加法重组满足结合律，
  **输出逐位不变**（cosim 复测 2048 样点 0 失配佐证）。
