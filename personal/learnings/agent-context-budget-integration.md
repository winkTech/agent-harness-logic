---
name: agent-context-budget-integration
description: Agent 上下文预算系统已接入 spawn 管道，宪法段受保护
metadata:
  type: reference
---

## 总结

`agent-context-budget.cjs` 的预算系统已真正接入 spawn-prompt-assembler 的 `enforcePromptBudget()`，取代原先的单一 `SPAWN_PROMPT_MAX_CHARS` 环境变量。

## 关键设计

- **宪法保护**: `## Agent Constitution` / `## Dynamic behaviour rules` 不在 removalOrder 中，硬截断时优先保留宪法段内容
- **移除顺序**: Entity Graph → Semantic Matches → Memory Context → Soul → (宪法从不删除)
- **注入时机**: self-compact 指令在 `enforcePromptBudget` 之前注入，超预算部分会被正常截断
- **Watchdog 钩入**: spawn-prompt-assembler.runtime.cjs 在组装完毕后自动调用 `watchdog.trackAgentSpawn()` 记录 spawn

## 验证

14/14 测试通过，覆盖所有 17 种 agent 类型的预算分配。

## How to use

```bash
node engine/scripts/agent-context-watchdog.cjs health   # 查看上下文健康摘要
node engine/scripts/agent-context-budget.cjs tier developer  # 查看 developer 预算
```

**Why:** 上 session 建了预算系统但没接入 spawn 管道，导致 agent 的宪法段在硬截断时被切掉。用户反馈"第二 agent 忘记规则"后，修正了 `enforcePromptBudget()` 的移除顺序 + 保护宪法段。
