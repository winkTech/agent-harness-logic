---
name: xdc-constraint-gen
description: 从 RTL 顶层端口自动生成 XDC 约束骨架 — 时钟周期 / 管脚分配 / 时序例外三类模板，端口全部带 TODO 标记待人工补值。用于新工程起约束、RTL 定稿后批量生成管脚骨架。已有 XDC 要做合规核查时用 engine/scripts/fpga-xdc-parser.cjs（解析方向），本技能只管生成方向。
version: 0.1.0
---

# XDC Constraint Gen — 约束骨架生成

**脚本**: `scripts/gen_xdc_from_rtl.py`（stdlib only，无需第三方依赖）
**模板**: `templates/` 下三类约束的语法基准（clock-period / pin-assignment / timing-exception）

## 为什么用它

约束文件的错误大头是**抄错端口名**和**漏掉端口** —— 这两件事机器比人可靠。
端口名、位宽、方向从 RTL 提取，`PACKAGE_PIN` / 周期数值 / 例外路径留 `TODO`
标记待人工确认后补值。生成的是**骨架**，不是最终约束。

## 调用

```bash
# 从顶层 RTL 生成约束骨架（stdout）
python scripts/gen_xdc_from_rtl.py path/to/top.v

# 指定顶层模块名（文件里有多个 module 时必须给）
python scripts/gen_xdc_from_rtl.py path/to/top.v --top top

# 输出到文件（默认覆盖前会提示）
python scripts/gen_xdc_from_rtl.py path/to/top.v -o 03_xdc/top_skeleton.xdc
```

## 生成内容与人工分工

| 区块 | 机器生成 | 人工 TODO |
|---|---|---|
| 时钟约束 | 端口名匹配 `clk*`/`clock*` 的单 bit 输入各一条 `create_clock` | 周期数值、波形（-waveform）、差分时钟对 |
| 管脚分配 | **每个端口**一条 `set_property PACKAGE_PIN` + `IOSTANDARD` | 引脚号、电平标准、上下拉 |
| 复位/异步信号 | 单 bit 输入中非时钟端口标注注释提醒 | 是否 false_path / max_delay |

## 闭环用法

1. 本脚本生成骨架 → 2. 人工补 TODO 值 → 3. `vivado-flow` 的 `-xdc` 消费该目录跑综合 →
4. `engine/scripts/fpga-xdc-parser.cjs` 解析回读做约束核查。
   生成方向（本技能）与核查方向（parser）分离，互相不越界。

## 模板基准

三个模板文件是各类约束的**语法权威示例**（含注释说明每行作用），手写补充约束时照抄格式：

- `templates/clock-period.xdc` — 主时钟、生成时钟、差分时钟
- `templates/pin-assignment.xdc` — PACKAGE_PIN、IOSTANDARD、上下拉、差分对
- `templates/timing-exception.xdc` — false_path、max_delay、clock_groups

## 边界

- 只解析 Verilog-2001 ANSI 端口声明（`input wire [W-1:0] name`）与普通非 ANSI 端口列表；
  SystemVerilog interface、参数化位宽 `#[` 会在输出头部警告并跳过该端口 —— 不要静默丢端口。
- 不推断引脚号、不推断周期：这是设计决策，机器只负责把名字和位宽抄对。
