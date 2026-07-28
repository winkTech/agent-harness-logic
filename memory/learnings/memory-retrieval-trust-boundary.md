---
name: memory-retrieval-trust-boundary
type: learnings
description: 记忆注入必须先按项目、路径与触发条件隔离，再校验证据和时效；Markdown、Dream 与旧标签不得绕过统一检索边界。
scope_kind: global_harness
trigger_kind: user_query
verification_state: verified
evidence_ref: test:engine/scripts/test-hooks/read-only-hooks.cjs
contract_hash: sha256:81bbc6c4ab446d9aa1df23fa231d53f48481816a60ac1ef159eefd36c527c1ea
valid_until: 2027-01-24T00:00:00Z
reviewed_at: 2026-07-28
---

# 记忆检索的信任边界

## 触发条件

当 Agent 因项目历史、既有文件、相同错误或先前决策而检索长期记忆时应用。

## 规则

1. 在相关性排名前，先按稳定 `project_id`、`scope_kind`、`path_scope`、`trigger_kind` 和 `trigger_signature` 做失败关闭过滤；缺少项目上下文时只允许 `global_harness`。
2. 默认注入只接受 `verification_state: verified`、非空 `evidence_ref`、非空触发类型和未过期 `valid_until`；候选与待复核事实只在显式审查模式中可见。
3. Markdown wiki 展开、Dream 启动摘要和旧 `verified` 文本标签都必须经过同一 SQLite 检索与信任过滤，不能形成旁路。
4. 检索命中只记录 exposure；只有后续独立动作、规则执行或标准化 Verification Gate 结果，才能分别记录 application 或 outcome，且默认不声称因果。

## 验证边界

- 行为命令：`node engine/scripts/test-hooks/read-only-hooks.cjs`
- 契约哈希：`sha256:81bbc6c4ab446d9aa1df23fa231d53f48481816a60ac1ef159eefd36c527c1ea`
- 已覆盖：跨项目隔离、缺证据/缺复核日期拒绝、过期拒绝、中文与路径相关性、Markdown 与 Dream 旁路阻断。
- 未外推：14 天真实召回收益趋势、外部模型长期行为改善和因果效果。

## 失效与复核

当事实 schema、项目身份算法、检索排序、Dream 注入、wiki 展开或 Verification Gate 契约变化时，将本条标记为 `needs-reverify` 并重跑行为命令；最迟于 `valid_until` 前复核。
