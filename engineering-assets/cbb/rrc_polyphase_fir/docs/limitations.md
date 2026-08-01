# rrc_polyphase_fir — 已知限制（1.0.0）

以下各条来自实测与治理台账，非推测。本文件是本资产已知限制的**权威清单**
（README §7 指向此处）；签字所接受的限制即复用方需要承担的约束，见
`manifest.json` 的 `signoff.scope`。

证据位置：`engineering-assets/evidence/rrc_polyphase_fir/1.0.0/`（哈希锁定快照）
与 `engineering-assets/var/gates/pg/rrc_polyphase_fir/`（实时目录）。
1.0.0 是版本号转正，RTL 与全部功能结论自 0.4.0（2026-07-25）起未变，
故本清单同样适用于 0.4.0。

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

5. **hold 在布线后仍未收敛，但违例全部落在 I/O 侧，内部时序是干净的。**
   2026-08-02 实跑 OOC 综合→opt→place→route（Vivado 2023.1.1），证据
   `hold-closure.json` + `route-timing-summary.rpt`：

   | 阶段 | WNS | WHS |
   |:---|:---|:---|
   | synth | +0.252 | −0.163 |
   | opt | +0.252 | −0.163 |
   | place | +0.006 | −0.163 |
   | route | **+0.058** | **−0.163** |

   - **原先"综合级 hold 是估算值、会在布局布线阶段收敛"的说法已被证伪** ——
     WHS 四个阶段一模一样，布线后 THS −20.056 ns、320/2713 端点失败。
   - **归因是确定的**：对 `post_route.dcp` 跑 `get_timing_paths -delay_type min
     -slack_lesser_than 0`，**924 条违例路径全部从输入端口出发，内部单元起点 0 条**；
     **reg-to-reg 最差 hold = +0.094 ns**，即本核内部 hold 已收敛。
   - 失败的只有 `i_rst` 一个端口（`s_axis_tvalid` +0.218、`m_axis_tready` +0.193
     都通过）。路径是 `i_rst → addA_i_reg[0]/RSTM (DSP48E1)`：到达
     0.100（XDC 占位输入延时）+ 0.510（走线）= 0.610，需求 0.537（时钟延时）
     + 0.035（不确定度）+ **0.201（DSP48E1 RSTM 的 hold 需求，远大于普通 FF）**
     = 0.773。差 0.163 ns。
   - **关闭条件（量化）**：`i_rst` 的真实最小输入延时 ≥ **0.263 ns** 即收敛。
     XDC 里的 0.100 ns 是它自己写明的"显式假设、非实测"占位值。
     板级上 `i_rst` 若由同域寄存器驱动并走一段线，通常远超该值 ——
     **但这必须由集成方用真实数值确认，CBB 级给不出结论**。
   - 若要在核内消除对集成方 I/O 时序的依赖，方向是把 `i_rst` 先在本核寄存一拍
     再驱动 DSP 复位脚，使该路径变成 reg-to-reg。代价是复位晚一拍，属**行为契约
     变更**，需重跑全部 bit-true 与 G-C-04/05 —— 未做，留给 owner 决策。
   - 附带：`place` 阶段 setup 一度只剩 **+0.006 ns**，裕量非常薄；
     `route-drc.rpt` 无 Critical Warning。布线后资源 LUT 220 / FF 258 / DSP 24。

   registry ITG-0009 的 `hold-closure` **仍不关闭**（布线后确有违例，如实记录、
   不做豁免），但状态已从"未知"推进到"已定位到单一端口、单一成因，并给出量化
   关闭条件"。

6. **（已还清，留记录）无哈希锁定证据快照。** 本资产的 `maturity.evidence_ref`
   曾指向 `var/gates/pg/rrc_polyphase_fir/` —— 一个由工具随时可覆盖重写的实时
   目录，而非哈希锁定快照；库内 certified 资产中只有本资产是这样，
   `evidence-snapshot --verify-all` 覆盖不到它。2026-08-02 已取快照并把
   `evidence_ref` 指过去（先 `0.4.0`，随版本号转正后为 `1.0.0`，0.4.0 转历史保留），
   全库 `--verify-all` 现为 **17 verified**。
   同时把混在证据目录里的两份工作产物（`implementation-diagnostic/`、
   `stoploss-validation-20260726-140818/`）挪到 `var/impl/` 下 —— 它们不是证据，
   留在快照源目录里会让快照边界失去意义。

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

10. **（已还清）版本号未随认证转正。** 资产自 2026-07-25 起就是 certified 且
    18 门全绿，但 `version` 一直停在 `0.4.0`，与库内其余 certified 资产（均已
    1.0.0）不一致，引用方按版本号推断成熟度会读错。2026-08-02 由 owner 裁定转正
    为 **1.0.0**；RTL、约束、TB 与全部功能结论自 0.4.0 起未做任何改动。

11. **（已还清，但结论有变）golden 侧的 `native-matlab-recheck`。**
    2026-08-02 已在本机 MATLAB R2022a 复核并关闭：本资产 bit-true 所锚的
    `models/comm/rrc/vectors/expected_tx.hex` **确认正确**，4096 个 int16 与
    golden 逐位一致，**本资产的 bit-true 结论不受影响、无需重跑**。
    但同一次复核查出 golden 自身有缺陷（`rrc_pulse_shaping.m` 对复数数组用
    `min`/`max` 做饱和，会把整条信号塌陷成常量），已随 `model_comm_rrc` 1.1.0 修复。
    **（原遗留分歧已于 2026-08-02 统一）**：`fixed_point_report.md` §3.3 原写
    convergent rounding（银行家舍入），而 golden、向量再生脚本与本 RTL 三者一致用
    half-away-from-zero。已改文档、不改实现，依据是实测 —— 原条款给的理由
    （"避免直流偏置"）**无法区分这两种模式**：平局（恰好 .5）在本设计里
    80 万样点只出现 24 次（3×10⁻⁵，入库的 4096 个 acc 中一次没有），
    三种模式（含经典有偏的 half-up）的误差 RMS 到小数点后 6 位完全相同、
    直流偏置都在量化噪声的 0.13% 量级；half-away 与 convergent 仅 11/800000
    点不同。反向改实现则要把 round-to-even 挂到 `round_clip` 这条已经是瓶颈、
    布线后 setup 只剩 +0.058 ns 的路径上，并重新取证三方。详见 §3.3 修订说明。
    **注意该结论依赖"平局稀疏"，不可外推到移位量小或系数含大 2 的幂公因子的滤波器。**

12. **仿真证据依赖 ModelSim。** README §6 的复现命令第 2 条是
    `vsim -c -do cbb/rrc_polyphase_fir/run.do`。本机 ModelSim 回环 RPC 自
    2026-08-01 起故障，该条命令当前**无法直接复现**；库内其余资产已改用
    Vivado xsim 取证，本资产的 TB/run.do 尚未做等价迁移。
