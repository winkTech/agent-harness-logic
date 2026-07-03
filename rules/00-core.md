---
name: core-rules
description: "Core instruction priority, checkpoints, lint-first, and verification loop."
priority: L0
trigger: "always"
skip: ""
---

# 核心规则

> L0 优先级。所有 session 加载。**规则是检查点的输入，不是背景噪音。**

---

## 铁律第零条：指令绝对优先

每次 Edit/Write/Bash 前输出：
```
行动: [做什么]  指令: "[原文]"  匹配: ✅/⚠️  门禁: 🚦[✅/❌] 🧪[✅/❌/N/A]
```
不匹配 → 停下 + 偏差报告 + 等确认。

---

## 项目四检查点（不可跳过）

### 检查点 0：知识库检索（收到需求后、设计前）
```
Glob knowledge/**/*.sv,.v,.py  →  Grep 功能关键词搜 knowledge/
→ Read 最相关 2-5 个示例全文  →  Read skills/hdl-coding/SKILL.md
→ 输出「示例分析」：命名/结构/接口/位宽 + 引用来源
```
**未搜索 knowledge/ → 不许设计。**

### 检查点 1：设计方案（编码前）
```
输出设计方案：接口(精确到bit) + FSM + 流水线 + 位宽
+ 示例对标(每个决策→示例行号) + 规则对标(每个决策→hdl-coding条款)
+ 模糊点 → 「待澄清清单」一次性列出来
```
**方案未确认 → 不许编码。**

### 检查点 2：编码自检（Write 前）
```
✅ ri_ 输入寄存 → §1.2  ✅ ro_ 输出寄存 → §1.3
✅ 三段式FSM  → §4    ✅ 同步复位   → §1.1
✅ 无锁存器   → §8    ✅ 位宽匹配   → §5
```
**引用 hdl-coding SKILL.md 具体条款 + 示例文件具体行。**

### 检查点 3：验证（编码后）
```
功能验证（仿真/pytest）≠ 语法检查（vlog -lint/ruff check）
→ 规则见 rules/03-gates.md 门禁二
```

---

## Lint First
- Verilog/SV: `vlog -lint`  /  Python: `ruff check`
- 仅改 Markdown/注释 免检

## 验证闭环
- 改代码 → 功能验证（仿真/pytest）→ 通过才提交
- 仅语法检查不算验证
- 三道闸门强制执行（见 CLAUDE.md）

## 项目约定优先
- 已提供 Golden Model / 参考规范 → 不讨论之外的事
- `memory/projects/` 有约定 → 按约定执行
