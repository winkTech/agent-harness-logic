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
| Vivado 可综合子集 / 综合属性 (UG901) | `skills/hdl-coding/references/vivado-synthesis-ug901.md` |
| Vivado RTL 方法学 / Know What You Infer (UG949) | `skills/hdl-coding/references/ug949-rtl-methodology.md` |
| Vivado 工具流 (RTL DRC / report_* / xsim) | `skills/hdl-coding/references/vivado-tool-flow.md` |

---

## Vivado 综合结论的证据要求

- **[MUST]** 资源 / Fmax / 时序 / 可综合性 / CDC 的结论必须有 Vivado 报告支撑，无 EDA 环境时写"未验证"
- **[MUST]** 红线 3（同步复位）的**唯一豁免**：BRAM 输出寄存器、DSP 内部流水寄存器、SRL 移位链中间级
  —— 加复位会阻断硬件宏推断。豁免须写注释 + 用 `report_utilization` 验证，细则见 `vivado-synthesis-ug901.md` §5.1
- **[MUST]** 禁止门控时钟（`always @(posedge (clk & en))`），改用 BUFGCE 的时钟使能
- 一键检查：`skills/vivado-flow/scripts/vivado_flow.tcl` —— `-to rtlcheck`（RTL 级）/ `-to synth`（综合级），判定读 `<out>/rpt/flow_summary.json`
