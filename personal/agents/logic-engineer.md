---
name: logic-engineer-agent
description: 逻辑工程师 Agent 定义已创建，位于 agents/domain/logic-engineer.md
metadata:
  type: reference
---

已创建 **logic-engineer** Agent，定义在 `agents/domain/logic-engineer.md`。

**角色**：RTL/FPGA 逻辑工程师
**模型**：sonnet（编码效率优先）
**边界**：不碰 Golden Model、不改定点位宽、不改算法方案
**技能**：hdl-coding, tdd, code-review, rag-skill, debugging, presentation（新增）
**协作对象**：[[algorithm-engineer-agent]] — 算法产出 → 逻辑实现
**工作流位置**：hdl-coding-workflow Phase 0（基础设施）→ Phase 3-7（TB/RTL/集成/综合/审查）

**2026-06-15 补全**：添加 `presentation` skill（画架构图/时序图）、6 个 context_files（OFDM/LDPC/信道估计/同步算法spec + 跨项目经验 + HDL规则）、模型策略（sonnet 默认/opus 升级条件）、争议升级路径（对齐→对比→调度→外部）
**2026-06-15 上下文**：添加 `compact-preservation-guide.md` context_file（输出自带压缩保留指引）

已在 `agent-context-budget.cjs` 注册为 `normal` 层级。
