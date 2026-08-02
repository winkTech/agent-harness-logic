<!-- asset-status: certified v1.0.0 -->
# complex_multiplier — 复数乘法器 (四乘法直算、全精度, certified CBB)

> **综合 (OOC, xc7k325tffg900-2)**: WNS +2.51ns @250MHz 即达成约 **671 MHz**;
> **DSP 4/4** (与四乘法直算的推算一致), LUT 0/120, FF 3/200, BRAM 0/0。
> LUT 0 / FF 3 是 DSP48E1 完美吸收的结果 —— 输入寄存进 A/B 寄存器、乘积进 M
> 寄存器、加减输出进后加器与 P 寄存器 (级联), fabric 侧只剩 3 拍 valid 链。
> **自检**: 7357 有效拍逐拍比对 0 失配 (独立 longint 参考模型)。
> **限制**: 见 [`docs/limitations.md`](docs/limitations.md) —— 8 条, 重点是
> **全精度输出不做舍入/饱和, 定标语义交调用方**。

计算 `(i_a_re + j*i_a_im) * (i_b_re + j*i_b_im)`,有符号全精度输出,
不截断不饱和 —— 定标语义交调用方,避免重蹈库内 4 套互不相同定点语义的覆辙。

| 特性 | 值 |
|:--|:--|
| 延迟 | 3 拍(输入寄存 → 四乘积寄存 → 加减寄存) |
| 吞吐 | 1 拍/样点(自由流水,valid 标记有效拍) |
| 位宽 | 输出 `P_A_W+P_B_W+1` 位;16×16 → 33 位,数学上不可能溢出 |
| 复位 | 同步高有效 `i_rst` |
| 背压 | 无 tready;需要背压时在输出侧例化 `axis_skid_buffer` |
| 参数 | `P_A_W` / `P_B_W`(默认 16/16) |

## 与模板原件的关系

改写自 `skills/hdl-coding/templates/comm/cmult.sv`(v1.0.0)。
原件标称"符合本规范",实测为**功能性错误**:复数乘法公式错(re=ac+bd)、
操作数张冠李戴、死寄存器、流水错拍 + 输入直通,四条独立缺陷逐条记录在
RTL 模块头。本模块弃用其三乘法结构,改四乘法直算(DSP 映射直观、
位宽推理无歧义)。

## 验证

`tb/tb_complex_multiplier.sv`(自检 TB,参考模型 = TB 内行为级全精度复乘,
Vivado xsim 2023.1):随机激励 + valid 气泡。
最近一次:3138 拍比对,2357 个有效拍 0 失配,实测延迟 3 拍,PASS。

## 限制与验证边界 (limitations)

- **全精度输出不截断不饱和**,定标语义交调用方;下游位宽收窄须自行负责舍入/饱和。
- 无 tready 背压;需要背压在输出侧例化 axis_skid_buffer。valid 仅是数据有效标记,非握手协议。
- 仅默认 16×16 参数实测;DSP 映射未做综合取证。
- **证据口径**:本包已 certified,综合时序/资源取证由 `pg-synth` 实跑并记入
  `envelope-check.json`;仿真证据由 **Vivado xsim 2023.1** 产出。全部结论均为
  **OOC 口径**(仅 `create_clock`,未布局布线、未绑引脚、未上板)。

## 证据复现

```bash
cd engineering-assets

# 仿真证据 (reset-sim.json / tb-selfcheck.json / stability/*.json)
bash tools/run-primitive-sim.sh complex_multiplier --install

# 综合证据 (timing-summary.rpt / utilization.rpt)
node tools/pg-synth.cjs cbb/complex_multiplier

# 门禁判定
node tools/gate-runner.cjs cbb/complex_multiplier --repo-root ..
```

不带 `--install` 只跑不写入门禁目录，便于与既有证据比对。
2026-08-02 用该脚本复跑本包，产出的 6 份证据与 certified 时的记录**逐字节相同**。
