---
name: algorithm-engineer-agent
description: 算法工程师 Agent 定义已创建，位于 agents/domain/algorithm-engineer.md
metadata:
  type: reference
---

已创建 **algorithm-engineer** Agent，定义在 `agents/domain/algorithm-engineer.md`。

**角色**：通信/DSP 算法工程师
**模型**：opus（算法分析精度优先）
**边界**：不写 RTL、不碰 EDA 工具、不优化 LUT/BRAM
**技能**：python-hardware-debug, rag-skill, debugging, modern-python
**协作对象**：[[logic-engineer-agent]] — 算法产出 → 逻辑实现
**工作流位置**：hdl-coding-workflow Phase 1（架构）→ Phase 2（定点）→ Phase 3（向量）→ Phase 4-5（配合验证）

**2026-06-15 补全**：添加 `rules/08-constraints.md` 保护钩子、模型策略（opus 默认/sonnet 降级条件）、争议升级路径（协商→调度→外部）
**2026-06-15 上下文**：添加 `compact-preservation-guide.md` context_file（输出自带压缩保留指引）

已在 `agent-context-budget.cjs` 注册为 `normal` 层级。
