---
name: hdl-rules
description: "HDL coding rules for Verilog/SystemVerilog work."
priority: L1
trigger: ".sv, .v, .vh, Verilog, SystemVerilog, RTL, HDL"
skip: "not HDL"
---

# HDL 编码规则

> L1 优先级。涉及 .sv/.v 时加载。详细规范 & 模板见 `skills/hdl-coding/SKILL.md`。

---

## 五条红线（违反 = FAIL）

1. **[MUST]** 输入寄存 `ri_`，禁止直通
2. **[MUST]** 输出由 `ro_` 驱动，禁止组合直出
3. **[MUST]** 同步复位高有效 `i_rst`，异步须做同步释放
4. **[MUST]** 三段式状态机 + `default` 分支
5. **[MUST]** 无锁存器：if→else, case→default, assign→完整条件

---

## 命名规范

| 前缀 | 含义 | 前缀 | 含义 |
|:-----|:-----|:-----|:-----|
| `i_` | 模块输入 | `o_` | 模块输出 |
| `ri_` | 寄存输入 | `ro_` | 寄存输出 |
| `r_` | 内部寄存器 | `w_` | 内部连线 |
| `P_` | 参数/状态 | `_cdc` | 跨时钟域 |

例外：标准总线（AXI/Wishbone/JTAG）保持协议原名。

---

## 代码结构

```
模块声明 → 参数 → ri_ 输入寄存 → ro_ 输出寄存 → 例化 → 状态机 → 组合逻辑 → 时序逻辑
```
每模块 ≤300 行，每 always ≤50 行。阻塞(=)组合，非阻塞(<=)时序，禁止混用。

---

## 模板参考（按需 Read）

| 需求 | 文件 |
|:-----|:-----|
| 三段式 FSM 模板 | `skills/hdl-coding/references/fsm-templates.md` |
| 流水线模板 | `skills/hdl-coding/references/pipeline-templates.md` |
| 复位模板 | `skills/hdl-coding/references/reset-templates.md` |
| TB 模板 | `skills/hdl-coding/references/tb-templates.md` |
| RTL 审查清单 | `skills/hdl-coding/references/rtl-code-review.md` |
| 代码对齐 & LUT 门禁 | `skills/hdl-coding/references/RTL_DESIGN_RULE.md` |
