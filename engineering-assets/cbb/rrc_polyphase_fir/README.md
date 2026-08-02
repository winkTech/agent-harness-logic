<!-- asset-status: certified v1.0.2 -->
<!-- 级别横幅（由成熟度派生）: CBB / CERTIFIED — 生产级，可在生产设计中复用 -->

# rrc_polyphase_fir

> `asset_uid: rrc_polyphase_fir` · `version: 1.0.2` · `owner: lihan`
> 成熟度: **certified** — 18 道 MUST 门全绿，`signoff.by=lihan @ 2026-08-02`
> （首次签署 2026-07-25 @ 0.4.0；RTL 与功能结论自那时起未变，1.0.0 是版本号转正）
> 证据: `engineering-assets/evidence/rrc_polyphase_fir/1.0.2/`（哈希锁定快照）
> 与 `engineering-assets/var/gates/pg/rrc_polyphase_fir/`（实时生成物，见 §6 复现）

RRC（根升余弦）脉冲成形多相 FIR 滤波器核。本包同时是库内 **CBB 参考样板**：
文档中每个数字都来自实测，全部证据可由 §6 的三条命令重生。

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

| 端口 | 方向 | 位宽 | 说明 |
|---|---|---|---|
| `i_clk` | input | 1 | 时钟 |
| `i_rst` | input | 1 | **同步复位，高有效** |
| `s_axis_tvalid` | input | 1 | AXI4-Stream 从端 |
| `s_axis_tready` | output | 1 | 空闲且未被下游堵住时为 1 |
| `s_axis_tdata` | input | 32 | `{Q[15:0], I[15:0]}`，Q2.14 |
| `m_axis_tvalid` | output | 1 | AXI4-Stream 主端 |
| `m_axis_tready` | input | 1 | 撤下即冻结整条流水，数据保持 |
| `m_axis_tdata` | output | 32 | `{Q[15:0], I[15:0]}`，Q2.14 |

**双向流控（0.4.0 起）**：入口每 5 拍可接收一个符号（4 个计算槽 + 1 拍空闲）；
出口若 `m_axis_tready` 撤下，整条数据通路冻结，`tvalid`/`tdata` 保持不变直到被接收。
背压下的数值正确性有实测证据，见 §5。

**延迟 7 拍**：输入寄存 1 + mac / addA / addB / sum / mag / ro 共 6。
输出对齐偏移 **16 个采样点**（= 4 符号群延迟 × 4 sps），源自 golden 的群延迟裁剪，与流水深度无关。

---

## 3. 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `DATA_W` | 16 | I/Q 各自位宽 |
| `COEFF_W` | 16 | 系数位宽（Q1.15） |
| `ACC_W` | 38 | 累加器位宽（容纳 9 项 16×16 乘积和且无截断） |
| `SPS` | 4 | 每符号采样数 = 多相相数 |
| `TAPS_PP` | 9 | 每相抽头数（33 抽头 / 4 相，零补齐） |

仅默认值经过验证。改参数须重跑 §6 全部证据。

---

## 4. 时序与资源包络（实测）

器件 `xc7k325tffg900-2`，**out-of-context** 综合（CBB 是核，不插 I/O 缓冲），Vivado 2023.1.1。

| 项 | 目标/预算 | 实测 | 判定 |
|---|---|---|---|
| 时钟约束 | ≤ 4.000 ns (250 MHz) | 4.000 ns | 约束不松于目标 |
| WNS (setup) | ≥ 0 | **+0.252 ns** | ✅ 0 个失败端点 |
| achieved fmax | ≥ 250 MHz | **266.8 MHz** | ✅ |
| LUT | 2800 | 231 | ✅ |
| FF | 1380 | 254 | ✅ |
| BRAM | 1 | 0 | ✅ |
| DSP | 24 | **24** | ✅ **零裕量**，见 §7 |

> WHS（hold）= −0.163 ns。**2026-08-02 实跑布线后时序，该值一动不动** ——
> synth / opt / place / route 四个阶段 WHS 全为 −0.163 ns，布线后 320/2713 端点
> hold 失败。此处原先写的"综合级 hold 是估算值、正常在布局布线阶段收敛"**已被证伪**。
> 归因明确：924 条违例路径**全部从输入端口出发，内部单元起点 0 条**，
> reg-to-reg 最差 hold **+0.094 ns**（内部已收敛）；全部由 XDC 里那个自称
> "显式假设、非实测"的 `set_input_delay -min 0.100` 支配。
>
> **该项不可由 RTL 关闭**——1.0.1 实测试过把 `i_rst` 寄存一拍让最差路径变成
> reg-to-reg，WHS 反而从 −0.163 ns 劣化到 **−0.189 ns**（新最差路径是
> `s_axis_tdata[5] → sym_buf_i_reg[0][5]/D` 这个普通 FDRE，hold 需求 0.227 ns
> 比 DSP RSTM 的 0.201 ns 还大），改动已回退。任何输入端口最终都要落进某个
> 触发器，而 `sym_buf_i_reg[0]` 本身就是输入寄存级。
> 详见 [`docs/limitations.md`](docs/limitations.md) 第 5 条与
> `var/gates/pg/rrc_polyphase_fir/hold-closure.json`。
>
> 布线后：WNS **+0.058 ns**（0/2713 失败，setup 收敛）、功耗 0.224 W、
> LUT 220 / FF 258 / DSP 24、`route-drc.rpt` 无 Critical Warning。
> 注意 place 阶段 setup 一度只剩 **+0.006 ns**，裕量很薄。

---

## 5. 验证证据

| 门 | 判据 | 结果 |
|---|---|---|
| `CS-1/CS-2` | manifest schema + 源哈希 | 通过 |
| `G-A-00/01/02/04` | 编译干净 / 同步高有效复位 / 命名 / 尺寸 | 通过 |
| `RL-OUT` | 输出由寄存器驱动（红线 2） | 通过 |
| `G-C-03` | 综合源无 `initial` | 通过 |
| `G-B-01/02` | 锚链起点 + golden 受治理 | 通过（`model_comm_rrc`） |
| **`G-B-03`** | 与 golden bit-true | **2048 样点 / 0 失配**，偏移 16 |
| `G-C-01` | 目标 fmax 收敛 | WNS +0.252 ns |
| `G-C-02` | 资源在包络内 | 4/4 项通过 |
| **`G-C-04`** | 复位健壮 + CDC | 8 个寄存器去断言 +1 拍均为复位值；复位后二次激励有响应；`cdc_tool=na`（单时钟域结构扫描，0 跨时钟路径） |
| **`G-C-05`** | 边界/压力/回归/背压 | 四个具名子结果均 pass，见下 |
| `G-GATE-01` | 证据齐备 | 5 项产物齐备 |
| `G-SIGN-01` | 具名签字 | `by=lihan @ 2026-07-25` |

**G-C-05 四个子结果**（`stability/*.json`，机器 AND，不接受聚合散文）：

| 子结果 | 判据 | 实测 |
|---|---|---|
| `boundary` | 全零输入→输出恒零；满量程正/负不溢出、valid 期间无 X/Z | pass |
| `backpressure` | 下游随机撤 `tready`（约 25% 拍）重跑同一向量 | **820 拍停顿下 0/2048 失配** |
| `stress` | 吞吐 ≥ 0.2 符号/拍 | 0.2003 |
| `regression` | 全向量 100% 通过 + 激励确定性（golden 固定 seed） | pass |

**bit-true 的边界**：2048 个采样点上 RTL 与 golden 定点模型逐位相同
（16QAM, α=0.5, sps=4 激励）。背压、复位、边界已由 G-C-04/05 单独覆盖；
**参数扫描仍未覆盖**（见 §3）。

---

## 6. 证据复现

三条命令，顺序执行；产物落在 `engineering-assets/var/gates/pg/rrc_polyphase_fir/`。

```bash
cd engineering-assets

# 1) 综合证据 (timing-summary.rpt / utilization.rpt / synth.log)
node tools/pg-synth.cjs cbb/rrc_polyphase_fir

# 2) 仿真证据 (alignment-report.json / reset-sim.json / stability/*.json)
#    两条等价通路, 同一份 TB、同一套判据, 任选其一。
#
#    2a) Vivado xsim —— 本机当前可用的那条
bash cbb/rrc_polyphase_fir/run_xsim.sh
#
#    2b) ModelSim —— 本机回环 RPC 自 2026-08-01 起故障, 当前跑不通, 保留备查。
#    -l 显式指定日志: ModelSim 在启动时的 CWD 就建 transcript, 早于 run.do 内的
#    cd, 不指定会在仓库根留下残桩。日志目录须已存在, 故用 var/ 而非其子目录。
# vsim -c -l var/rrc-cosim.log -do cbb/rrc_polyphase_fir/run.do

# 3) 门禁判定 (逐门 pass/fail/blocked + envelope-check.json + cdc-report.json)
node tools/gate-runner.cjs cbb/rrc_polyphase_fir --repo-root ..
```

向量由 golden 侧生成，权威位置 `models/comm/rrc/vectors/`（治理规范 §5.5）。
路径注入两条通路，**TB 内均不出现硬编码绝对路径**：ModelSim 经
`+VEC_DIR` / `+RPT_F` / `+EVID_DIR` 传绝对路径；xsim 的 `-testplusarg` 在 Windows 上
会在 `=` 与盘符处把参数切碎，故改为由 `run_xsim.sh` 先把向量拷进构建目录、
TB 按**运行目录相对**读写、跑完再把证据搬到门禁约定位置。

---

## 7. 已知限制

> **权威清单在 [`docs/limitations.md`](docs/limitations.md)** —— 12 条，含本节
> 5 条以及治理侧的 7 条（无哈希锁定证据快照、未上板、版本号未转正、golden
> 侧 `native-matlab-recheck` 未还清、bit-true 覆盖边界、群延迟偏移易混点、
> ModelSim 复现路径当前不可用）。此处只留架构与时序侧的摘要，避免两份清单漂移。

1. **DSP 零裕量**（24/24）。架构为 9 抽头/相 × I/Q 双路 = 18 个乘法器，
   另 6 个被综合器用作加法树后加器。若需压缩，方向是实现对称折叠
   （设计报告 §5.2 假设的 5 DSP 即基于此，当前 RTL 未实现）——属架构改动。
2. **hold 未收敛**（综合级 −0.163 ns）。见 §4 注。
3. **仅默认参数经过验证**。见 §3。
4. **CDC 未经具名工具**。本核为单时钟域，`cdc-report.json` 标 `cdc_tool=na`，
   仅陈述结构扫描结果（0 跨时钟路径），**不声称 clean**。多时钟域集成场景不适用本结论。
5. **入口吞吐上限 0.2 符号/拍**。每符号需 4 个计算槽 + 1 拍空闲；若系统要求
   更高符号率，需并行例化或重构相位调度。

---

## 8. 认证状态

**已认证（certified）1.0.0**，位于 `cbb/`，18 道 MUST 门全绿。

签字记录在 `manifest.json`（字段结构由 `schemas/cbb-manifest.schema.json` 约束，
必填 `by` / `at` / `scope`），当前为 `by=lihan @ 2026-08-02`，8 条 scope。

**不要在此处复制签署原文** —— 0.4.0 时这里贴过一份，随后
`signoff.scope` 改了而这里没跟上，就成了两份会漂移的清单。
以 `manifest.json` 的 `signoff` 字段为准。

1.0.0 相对 0.4.0 签署内容的实质变化有两处：

1. 改掉一条**被实测证伪**的措辞——原写"已接受限制：综合级 hold 未收敛，
   上板前须以实现后时序为准"，实测表明它不会自行收敛（WHS 四阶段恒定），
   已改为如实陈述违例、归因与量化关闭条件。
2. 补进三条此前只在文档里、没进签署范围的限制：setup 裕量薄、未上板、
   ModelSim 复现路径当前不可用。

> 复用前请读 [`docs/limitations.md`](docs/limitations.md) —— 签字所接受的限制，
> 即是复用方需要承担的约束。

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

- **0.3.0（数值）** — 原系数表与 golden 不符，且相 1–3 采用数学上不成立的对称折叠
  （33 抽头 RRC 仅相 0 自对称）。由 cosim 门禁捕获后重写。
- **0.3.0（时序）** — 累加级原为单拍 9 项连加，被综合器映射成 7 级 DSP48 PCOUT
  级联（≈11 ns），WNS −6.211 ns / 实际 ~98 MHz。改为 3 级寄存加法树后瓶颈转移到
  `round_clip`（19 逻辑级 / 15 个 CARRY4 / 4.56 ns），再拆为两级，最终 WNS +0.252 ns。
  代价是延迟由 4 拍增至 7 拍；ACC_W=38 全精度无截断，加法重组满足结合律，
  **输出逐位不变**（cosim 复测 2048 样点 0 失配佐证）。
- **0.4.0（流控）** — 原 `s_axis_tready` 恒 1 且 `m_axis_tready` 完全不参与节流，
  两侧都无流控，`G-C-05` 背压子结果无法通过。补上入口 ready 与出口停顿门控后，
  TB 的 cosim 驱动循环（原固定每 4 拍发一拍、不看 tready）随即暴露为会静默丢符号
  （实测 2048/2048 全失配），一并改为按握手推进。背压下复测 0/2048 失配。
