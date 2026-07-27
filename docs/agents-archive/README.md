# Agent 角色定义（已归档 — 不可调用）

> **归档于 2026-07-27（PI 审查）。** 本目录原先位于 skills 目录下，作为注册技能声称
> "供 Harness 调用的预定义 Agent 角色"，可用 `agent(prompt, {agentType: 'architect'})` 调用。
> **该声明是错的**：其中 17 个角色没有一个在本 harness 的 agent 注册表里，照它写的工作流
> 会调到解析不出来的 agentType。加之全目录 171 条引用指向本仓库不存在的生态
> （enterprise 工作流目录、workspace-conventions 规则、旧版 memory 单文件布局、
> HOOK_AGENT_MAP 等），判定为上游 harness 的导入残留。
>
> 移出技能目录后它不再被注册为技能，仅作为**角色提示词写法的参考资料**保留。
> 目录内各文件的路径引用一律按"上游布局"理解，不对应本仓库。

---

## 真实的 Agent 注册表在 `agents/`

只有这些 agentType 可被 `Agent` 工具与 `agent(prompt, {agentType})` 解析：

| 目录 | Agent | 职责 |
|:-----|:------|:-----|
| `agents/domain/` | `algorithm-engineer` | Golden Model、定点量化、测试向量、算法性能 |
| `agents/domain/` | `logic-engineer` | RTL/TB/仿真/顶层集成/综合实现 |
| `agents/compound/` | `ce-correctness-reviewer` | HDL 逻辑正确性审查 |
| `agents/compound/` | `ce-api-contract-reviewer` | 接口契约 / 握手 / AXI-Stream 合规 |
| `agents/compound/` | `ce-architecture-strategist` | 微架构合规审查 |
| `agents/compound/` | `ce-performance-oracle` | Fmax / 资源 / 时序瓶颈 |

平台内置的 `general-purpose`、`Explore`、`Plan`、`claude` 等由 harness 直接提供，不在本仓库定义。

## 本目录内容

17 份角色提示词（`core/`、`domain/`、`orchestrators/`、`specialized/`）：
architect、developer、planner、qa、researcher、code-reviewer、code-simplifier、
context-compressor、data-scientist、general-assistant、master-orchestrator、memory-manager、
performance-engineer、python-pro、technical-writer、reflection-agent、advanced-debugging。

**使用方式**：写新 agent 定义时可参考这里的结构与措辞。**不要**按其中的路径引用去找文件，
也**不要**把其中的角色名当作 agentType 使用。

新增可调用 agent 的正确做法：在 `agents/<类别>/<name>.md` 建定义（frontmatter 的 `name`
必须与文件名一致），CI 的注册表检查会校验。

> 若要恢复为技能（把本目录移回 skills 下），必须先把 17 个角色真正注册进 agent 注册表，
> 否则会重新引入"广告不存在的 agentType"这个缺陷。
