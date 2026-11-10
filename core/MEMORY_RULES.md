---
name: memory-rules
description: "Memory tiers, retrieval triggers, freshness, validation, retention, and retirement."
metadata:
  type: reference
  reviewed_at: 2026-07-28
---

# 记忆层治理规则

记忆层的目标是让 Agent 在正确场景召回少量、有效、可验证的经验，不是保存全部过程。运行日志属于遥测；候选经验属于待审材料；只有经过验证且仍然适用的内容才是长期记忆。

Harness 自身的稳定规则与晋升流程见 `docs/rules/05-harness.md`。

## Memory tiers

| 层级 | 内容 | 默认位置 | 是否自动注入 |
|:-----|:-----|:---------|:-------------|
| Runtime telemetry | 工具事件、Hook 事件、成本、临时状态 | SQLite `runtime_events`、`var/` | 否，只供诊断和聚合 |
| Working state | 当前目标、已验证证据、阻塞、下一动作 | `var/active-task.yaml`、`var/work/` | 仅 `/start` 或明确恢复任务 |
| Candidate experience | 错误根因、可能修法、Dream 模式、规则候选 | `memory/errors/`、候选账本 | 否，触发匹配时检索摘要 |
| Validated learning | 已复现根因、已通过行为验证、可复用预防动作 | `memory/learnings/`、SQLite facts | 按精确触发条件召回 |
| Durable harness rule | 跨任务稳定且显式批准的 Harness 约束 | `docs/rules/05-harness.md` 等仓库规则 | 由 Rule Loader 按场景加载 |
| Domain knowledge | 与单次会话无关的技术资料与规范 | `engineering-assets/knowledge/` | 按任务主题检索 |

`tool_success` / `tool_error` 是运行遥测，不是记忆；单次 Hook 成功、命令回显、空模板、未分析失败和重复 session 摘要不得进入长期记忆。

## Retrieval triggers

Agent 在以下任一条件满足时做一次轻量检索：

1. 用户提到既有仓库、模块、文件、Hook、错误签名或此前决定；
2. 当前任务依赖工作区约定，或正确答案可能因历史实现而不同；
3. 同一错误再次出现，或同一种修法连续两次无进展；
4. 准备修改记忆、Dream、检索、维护、Hook 语义或 Harness 规则；
5. 用户明确要求延续、复盘、从历史经验学习。

检索顺序：先主题/路径/错误签名过滤 registry 或 SQLite，再读取最相关的 1–3 条；需要原始命令或 payload 时才打开对应证据。无直接命中即停止，不扫描全部历史。

召回必须同时匹配候选条目的 trigger conditions。只有主题词相似但工具、阶段、payload 或失败模式不同，不得注入正文。回答中把已验证事实、合理推断和可能过时的信息分开。

SQLite 查询必须在相关性排名前按稳定 `project_id`、`scope_kind`、`path_scope`、`trigger_kind` 和 `trigger_signature` 失败关闭。缺少项目上下文时只允许 `global_harness`；`unscoped` 与跨项目事实只允许显式审查，不得进入 Agent 默认上下文。默认检索只接受 `verification_state: verified` 且 `valid_until` 未到期的事实。

Markdown 经验同步到 SQLite 时使用以下适用性 frontmatter；仓库/path/component/toolchain 作用域必须带稳定 `project_id`，path 还必须带 `path_scope`：

```yaml
scope_kind: repository
project_id: project-<stable-hash>
path_scope: engine/scripts/**
trigger_kind: file_edit
trigger_signature: memory_retrieval
verification_state: verified
evidence_ref: test:harness-painpoints
contract_hash: sha256:<contract-hash>
valid_until: 2027-01-24T00:00:00Z
```

`trigger_signature` 只有在 Hook 能从真实 payload 稳定生成同一签名时才填写；自然语言 `user_query` 通常只使用 `trigger_kind` 与内容相关性。文件对账把 Markdown 视为完整权威快照，删除字段必须清除 SQLite 中的旧值；普通运行时局部 upsert 才保留未提供字段。

语义查询前检查 index 与 meta、eligible 文件集合、mtime 和 builtAt。任一不一致时返回 `stale_index`，先显式重建；禁止用旧结果继续决策。

## Freshness and verification

长期条目至少包含：

- 适用范围与精确触发条件；
- 可复现的症状或真实输入形状；
- 根因，而非只记录现象；
- 已验证修复与预防动作；
- 验证命令、结果、时间和证据边界；
- 失效条件或复核日期。

时效判断优先使用证据时间与依赖契约，不使用“文件还在”代表有效：

- 代码、payload、工具版本、数据库 schema 或规则契约变化后，相关记忆标记 `needs-reverify`；
- 只有静态分析或模型解释的内容标记 `candidate`，不能称为 validated；
- 行为测试、仿真或真实回归的 PASS 只能证明其覆盖范围，不能外推到未运行层级；
- 互相冲突时，当前仓库代码/测试/官方资料优先，旧条目标记 `superseded` 并指向替代项；
- 召回命中但长期未被使用的条目应降低优先级，不能仅因“永久”标签常驻上下文。

Harness 规则的唯一晋升链为：

`candidate -> verified -> approved -> promoted`

Dream 和自动维护最多推进到 candidate；verified 必须引用 Verification Gate 证据账本中同一命令、同一行为契约且按时间排序的真实 RED/GREEN，并通过 entry SHA-256、输出哈希和退出码复核；approved 需要显式人工批准；promoted 才可进入仓库规则。规则加载与硬门禁执行还会校验 candidate id、批准记录和晋升文件 SHA-256，缺账本、手工复制或被篡改的规则保持不生效并进入健康告警。

## Attribution boundary

一次召回按 `retrieval/session/project/memory/correlation` 完整身份记录 `exposure`。同一工具的 PreToolUse/PostToolUse 锚点只消费 exposure，不算应用；后续动作最多记为 weak `observed-followup`，精确 trigger match 为 medium，已批准规则的硬门禁命中为 strong `rule-enforced`。只有 Verification Gate 的标准化结果可以写 outcome，命令、stdout、stderr 只保存哈希；模型自报、普通 observer 和 hit count 都不能写 PASS。所有记录保持 `causal_claim: unproven`，除非另有受控实验设计。

## Retention and retirement

| 类型 | 默认保留 | 到期动作 |
|:-----|:---------|:---------|
| Runtime telemetry | 14 天，且所有已注册 consumer-specific watermark 均已消费 | 仅经 `purgeConsumedEvents` 受控删除；未消费事件不得删 |
| Working state | 当前 session；跨 session 仅保留活动目标 | 汇总关键证据后退役原始过程 |
| 噪声/空模板/重复工具记录 | 最多 14 天 | 删除或不迁移，不做经验提炼 |
| 未验证 candidate | 30 天 | 有复现计划则续期，否则 retire |
| 已验证、待批准 candidate | 90 天 | 重新确认价值，未批准则 retire |
| 结构化错误记录 | 90 天 | 提炼为 validated learning 后退役原记录 |
| Validated learning | 180 天复核一次 | 合并重复项、reverify、supersede 或 retire |
| 项目状态 | 项目结束后 30 天 | 只保留可复用决策与证据边界 |
| Promoted harness rule | 无固定 TTL；契约变化或 180 天复核 | 保留、修订或通过审批退役 |

退役状态使用 `retired`、`superseded` 或 `needs-reverify`，并记录原因与替代项。Archive 不是无限期垃圾桶：不参与默认召回，超过审计保留期且无引用价值时再经明确清理。

## Maintenance contract

每周或健康检查报告 due 时运行维护：

1. `dry-run` 只计算事件保留、SQLite/Markdown 对账、候选提炼和索引重建计划，不写任何状态；
2. 审查候选是否具备根因、verified fix、prevention、trigger conditions；
3. execute 只调用受控 retention、reconcile、candidate staging、reindex 和 state 接口；
4. `kb-stats --check --quiet --json` 与 health JSON 均成功后才可称为维护完成；
5. 文件数量减少不是成功标准，召回命中率、exposure/application/outcome、candidate aging、过时项退役、未消费事件和一致性才是结果证据。

每个注册事件消费者都必须有真实、有界调度。消费者未调度或落后时，健康检查失败且清理阻塞；不得筛掉该消费者制造可删除水位。永久退役消费者必须通过显式 schema migration 和未消费依赖审计。

禁止直接删除门禁状态、强推任何 consumer watermark、把 raw Dream 输出写成规则、把原始错误批量移动后声称已提炼，或让 dry-run 修改数据库、索引、候选账本和维护时间。
