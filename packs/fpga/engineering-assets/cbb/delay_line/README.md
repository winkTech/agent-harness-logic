<!-- asset-status: certified v1.0.1 -->
# delay_line — 定长流水延迟线 (valid 标记、无背压, certified CBB)

> **综合 (OOC, xc7k325tffg900-2)**: WNS +3.352ns @250MHz 即达成约 **1543 MHz**;
> LUT 1/40, FF 66/80 (与结构推算 66 完全吻合), BRAM 0/0, DSP 0/0。
> **自检**: 9082 拍逐拍比对 0 失配 (P_DELAY=2 与 7 两个例化并行验证)。
> **限制**: 见 [`docs/limitations.md`](docs/limitations.md) —— 8 条, 重点是
> **数据链刻意不复位** (为 SRL 推断) 与 **无 tready 反压接口** (背压由
> axis_skid_buffer 承担)。

流水对齐的基础原语:`o_valid/o_data` 是 `i_valid/i_data` 精确延迟 `P_DELAY` 拍的副本。

| 特性 | 值 |
|:--|:--|
| 延迟 | 恒等于 `P_DELAY` 拍(最小 2:输入/输出寄存各占一级,红线 1/2) |
| 吞吐 | 1 拍/beat,自由流水 |
| 背压 | 无 tready(与 complex_multiplier 同约定);需要背压在输出侧例化 `axis_skid_buffer` |
| 复位 | 同步高有效;**valid 链清零,数据链不复位**(省复位扇出、利于 SRL 推断);在途 beat 复位丢弃属契约行为 |
| 参数 | `P_DWIDTH`(默认 32)/ `P_DELAY`(默认 2) |

## 与模板原件的关系

**合并取代两件**(裁决:定长延迟与背压是正交职责,分别由本模块与 axis_skid_buffer 承担):
- `skills/hdl-coding/templates/comm/pipe_delay.sv`:`o_ready` 组合穿通 `i_ready`(违反红线 2,与
  axis_pipeline_reg 同类)、全局停顿结构、stage0 valid 清除条件错、复位清数据链阻 SRL
- `skills/hdl-coding/templates/comm/delay_sync.v`:端口无 i_/o_ 前缀、无 valid 语义

缺陷逐条记录在 RTL 模块头。

## 验证

`tb/tb_delay_line.sv`(自检 TB,参考模型 = SV 队列,Vivado xsim 2023.1):
- P_DELAY=2(最小)与 P_DELAY=7 双例化,共 9082 拍逐拍比对 0 失配
- 随机气泡流 + 连续满流,valid 计数守恒(复位丢弃的在途 beat 按契约扣账)
- 运行中复位后 P_DELAY 拍内 o_valid 无残留,恢复正常

## 限制与验证边界 (limitations)

- **定长延迟,无背压契约**(库级裁决:与 axis_skid_buffer 正交分职)。
- 仅默认参数实测;SRL 推断未做综合取证。
- **证据口径**:本包已 certified,综合时序/资源取证由 `pg-synth` 实跑并记入
  `envelope-check.json`;仿真证据由 **Vivado xsim 2023.1** 产出。全部结论均为
  **OOC 口径**(仅 `create_clock`,未布局布线、未绑引脚、未上板)。

## 证据复现

```bash
cd engineering-assets

# 仿真证据 (reset-sim.json / tb-selfcheck.json / stability/*.json)
bash tools/run-primitive-sim.sh delay_line --install

# 综合证据 (timing-summary.rpt / utilization.rpt)
node tools/pg-synth.cjs cbb/delay_line

# 门禁判定
node tools/gate-runner.cjs cbb/delay_line --repo-root ..
```

不带 `--install` 只跑不写入门禁目录，便于与既有证据比对。
2026-08-02 用该脚本复跑本包，产出的 6 份证据与 certified 时的记录**逐字节相同**。
