# ldpc_codec — 已知限制（1.0.0）

以下各条来自实测与治理台账，非推测。验证证据见
`engineering-assets/evidence/ldpc_codec/1.0.0/`（哈希锁定快照）与
`engineering-assets/var/gates/pg/ldpc_codec/`（实时目录）。
签字所接受的限制见 `manifest.json` 的 `signoff.scope`。

---

## 适用范围

1. **码型写死，不是通用 LDPC 核。** 802.11n QC-LDPC，`R=1/2 / N=648 / K=324 / Z=27`。
   校验矩阵由 `h_matrix_addr` 的常量表给出，PT 列由 `rtl/pt_columns.hex`（324×324）
   给出 —— 换码率、换码长、换 Z 都需要重新生成这两张表并重新取证，不是改参数。

2. **定点契约固定，偏离即失去 bit-true 基线。** LLR `Q(10,4)`、内部 10 bit、
   归一化系数 `alpha = 12/16`（纯移位加法，0 DSP）、`max_iter = 20`、syndrome 早停。
   golden `models/comm/ldpc/src/ldpc_decoder_ms_fixed.m` 用的是同一组参数
   —— 3240 点 0 失配这个结论**只在这组参数下成立**。

3. **译码器是归一化 Min-Sum，不是 BP。** 与浮点 sum-product 上界有固有性能差距；
   golden 侧 `ldpc_decoder_bp.m` 才是算法上界基准。要 BER 结论请查 golden 侧的
   `test_ber_awgn.m` / `test_min_sum_vs_bp.m`，本 RTL 包不提供 BER 取证。

## 综合与包络的覆盖边界

4. **综合顶层只有 `ldpc_decoder_top`。** 全部时序/资源结论
   （WNS 4.958 ns @ 10 ns、achieved 198.33 MHz、LUT 410/900、FF 244/500、
   BRAM 3/3、DSP 0/0）都只覆盖译码器。**同包第二顶层 `ldpc_encoder_top`
   没有独立的综合包络证据** —— 编码器的面积与 Fmax 属未取证项。
   这条已写入 signoff.scope，是签字时明确接受的限制。

5. **BRAM 零裕量（3/3）。** 预算取自 stage7 实现报告 §6 的译码器一列。
   任何增加缓冲深度的改动都会直接超包络。

6. **器件归一悬案。** XDC 抬头写 `XCZU67DR`，实际综合用 `xc7k325tffg900-2`
   （本机未装 ZU67DR，且库内其余资产统一 XC7K325T）。见 `manifest.device.note`。
   **报告中的时序数字属 Kintex-7 口径**，不能直接搬到 RFSoC 上用。

7. **OOC 综合口径。** 仅 `create_clock`，未做布局布线与 I/O 绑定，未上板。

## 结构与接口

8. **D1：编码器输入未寄存（红线 1 遗留）。** `ldpc_encoder_top` 的
   `s_axis_info_tvalid/tdata` 仍被直接消费，未经 `ri_` 寄存，加载相位与计数耦合。
   2026-07-31 起已有 bit-true 基线（5/5），可安全做 `ri_` 重构回归，但**本版未做**。

9. **编码器用 PT 列 ROM，面积大于理想双对角。** 这是一次有意的取舍：旧双对角
   回代实现对非全零信息位 `H·c ≠ 0`（全零碰巧通过），已废弃。功能正确性优先于资源。
   若要减面积，须在**保持 bit-true** 的前提下重做结构。

10. **编码器吞吐 1 bit/cycle。** AXI-Stream 逐位输入，324 拍装载一个码字。

11. **译码器单码字端到端 70098 拍**（实测，预算 150000）。这不是高吞吐核；
    需要更高吞吐要靠多实例并行，本包不提供多码字流水。

12. **`h_matrix_addr` 保留 `initial`。** 纯常量阵列初始化，属 ROM 推断的标准写法；
    gate-runner G-C-03 对"仅初始化存储器阵列"的 `initial` 明确不判为违规，且该文件
    已由 Vivado 综合日志证实无 `[Synth 8-6896]`（未被丢弃）。
    **同一个坑在 `ldpc_encoder_top` 上真实发生过** —— 那里的 `initial` 条件依赖
    reg 数组内容、被 Vivado 判为非常量并整块丢弃（仿真有值、综合后无驱动源），
    已改为编译前展开成 `rtl/ldpc_encoder_tables.vh` 的 `localparam`。
    移植本模块到其他综合器时**必须重新确认这一点**。

13. **CDC 未经具名工具。** 单时钟域，`cdc-report.json` 标 `cdc_tool=na`，
    只陈述结构扫描结果（0 跨时钟路径），**不声称 clean**。
    跨域接入需在边界外自行同步，或用已认证的 `cdc_sync`。

## 验证覆盖边界

14. **bit-true 的覆盖**：译码器 10 向量 × 324 硬判决位 = 3240 点 0 失配；
    编码器 5 组 × 648 位 5/5 PASS。**向量来自 golden 侧固定 seed 生成，
    且经过定点可达性筛选**（浮点可译但定点 20 迭代不收敛的向量会被重抽）——
    这意味着 bit-true 结论不覆盖"定点不可达"的那类信道条件。

15. **G-C-05 的四个子结果**（均为实测，非聚合散文）：
    背压 567 拍撤 tready → 0/324 失配；边界全零 LLR 与满幅饱和 LLR → 324 位输出、
    无 X/Z、无挂死；压力单码字 70098 拍；回归 10 向量 + 同输入重跑逐位一致。
    **未覆盖**：连续多码字背靠背、复位中途打断、AXI 协议层随机化。

16. **UVM 环境未纳入门禁。** `tb/uvm/` 依赖本机 Vivado UVM 包路径，
    不在 gate-runner 默认路径内 —— 它产出的结论不构成本资产的取证。

17. **仿真证据由 ModelSim 10.6c 产出**（`alignment-report.json` 的 `tool` 字段）。
    本机 ModelSim 回环 RPC 自 2026-08-01 起故障；库内后续资产已改用 Vivado xsim
    取证，本包的 TB / `run_sim.do` 尚未做等价迁移，**当前无法按原路径直接复现**。
