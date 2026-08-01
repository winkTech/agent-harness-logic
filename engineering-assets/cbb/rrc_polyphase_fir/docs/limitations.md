# rrc_polyphase_fir — 已知限制（0.4.0）

以下各条来自实测与治理台账，非推测。本文件是本资产已知限制的**权威清单**
（README §7 指向此处）；签字所接受的限制即复用方需要承担的约束，见
`manifest.json` 的 `signoff.scope`。

证据位置：`engineering-assets/var/gates/pg/rrc_polyphase_fir/`（见第 6 条：
本资产的证据目录是**可再生的实时目录，不是哈希锁定快照**）。

---

## 数值与架构

1. **DSP 零裕量（24/24）。** 架构为 9 抽头/相 × I/Q 双路 = 18 个乘法器，另 6 个
   被综合器用作加法树后加器。设计报告 §5.2 声称的 5 DSP 建立在**对称折叠**之上，
   当前 RTL 未实现该折叠 —— 33 抽头 RRC 仅相 0 自对称，相 1–3 零补齐后不可折叠。
   要压缩 DSP 属架构重做，不在本版范围。**任何会增加乘法器的参数改动都会直接超包络。**

2. **仅默认参数经过验证。** `DATA_W=16 / COEFF_W=16 / ACC_W=38 / SPS=4 / TAPS_PP=9`
   之外的取值**全部未取证**（含 bit-true、时序、资源三方面）。改参数须重跑
   README §6 的三条命令重新取证。参数扫描不在本版覆盖内。

3. **入口吞吐上限 0.2 符号/拍**（实测 0.2003）。每符号需 4 个计算槽 + 1 拍空闲。
   系统若要求更高符号率，需并行例化或重构相位调度 —— 不能靠提高时钟解决，
   因为 250 MHz 已经是本核的收敛目标（实测 266.8 MHz）。

4. **输出对齐偏移 16 个采样点**，源自 golden 的群延迟裁剪（4 符号群延迟 × 4 sps），
   **与流水线深度（7 拍）无关**。集成方做对齐时不要把这两个数混为一谈。

## 时序与验证边界

5. **hold 未收敛（综合级 −0.163 ns）。** G-C-01 的判据只取 setup WNS，hold 在综合
   阶段本就是估算值、正常在布局布线阶段收敛 —— 但本资产**从未跑过实现后时序**，
   所以"会收敛"是预期而非结论。registry ITG-0009 将 `hold-closure` 列为未还清项。
   **上板前必须以实现后（post-route）时序为准。**

6. **无哈希锁定证据快照。** 本资产的 `maturity.evidence_ref` 指向
   `var/gates/pg/rrc_polyphase_fir/` —— 一个由工具**随时可覆盖重写**的实时目录，
   而非 `evidence/<asset_uid>/<version>/` 下的哈希锁定快照。库内 16 个 certified
   资产中，**只有本资产是这样**（`evidence-snapshot --verify-all` 覆盖 15 个，
   不含本资产）。后果：本包的证据无法被 `--verify-all` 证明未被改动过。

7. **未上板。** registry ITG-0009 的 `maturity_status` 仍是 `internal-validation`，
   `badge_gap` 含 `board-validation`。全部时序/资源结论均为 **OOC 综合口径**
   （`xc7k325tffg900-2`，仅 `create_clock`，不插 I/O 缓冲、未布局布线）。

8. **CDC 未经具名工具。** 本核为单时钟域，`cdc-report.json` 标 `cdc_tool=na`，
   只陈述结构扫描结果（0 跨时钟路径），**不声称 clean**。多时钟域集成场景不适用
   本结论 —— 跨域接入需在**边界外**自行做同步，或改用已认证的 `cdc_sync`。

9. **bit-true 的覆盖边界**：2048 采样点、16QAM / α=0.5 / sps=4 单一激励配置，
   0 失配。背压（820 拍停顿）、复位（8 寄存器）、边界（全零/满量程）由 G-C-04/05
   单独覆盖。**其余调制、其余 α、其余 sps 未取证。**

## 治理状态

10. **版本号未随认证转正。** 资产已 certified 且 18 门全绿，但 `version` 仍是
    `0.4.0`（库内其余 certified 资产均已转 1.0.0）。引用方按 `0.4.0` 钉版即可，
    但不要据版本号推断成熟度 —— 以 `maturity.level` 为准。

11. **golden 侧仍挂 `native-matlab-recheck`。** 对标模型 `model_comm_rrc`
    （registry ITG-0006）尚未在原生 MATLAB 环境复核过。本资产的 bit-true 结论
    锚在该 golden 上，golden 的这项遗留同样是本资产结论的前提条件。

12. **仿真证据依赖 ModelSim。** README §6 的复现命令第 2 条是
    `vsim -c -do cbb/rrc_polyphase_fir/run.do`。本机 ModelSim 回环 RPC 自
    2026-08-01 起故障，该条命令当前**无法直接复现**；库内其余资产已改用
    Vivado xsim 取证，本资产的 TB/run.do 尚未做等价迁移。
