---
name: cognitive-layer-routing
type: learnings
description: 认知层是否生效的可信路由事实：UserPromptSubmit 由 prompt-context 合并 rule-loader、memory-retrieve 与 frustration-detector。
scope_kind: global_harness
trigger_kind: user_query
verification_state: verified
evidence_ref: test:engine/scripts/test-hooks/prompt-context-contract.cjs
contract_hash: sha256:0fb9d384aece90f72103fc43b747cfcc6dc2bf9351fb3ac7e3c90775fda1c9c1
valid_until: 2027-01-24T00:00:00Z
reviewed_at: 2026-07-28
---

# 认知层路由与召回契约

## 触发条件

当用户检查认知层、规则加载、历史记忆召回或挫败模式切换是否生效时使用。

## 根因

`prompt-context.cjs` 只合并了 `rule-loader` 与 `memory-retrieve`，没有调用
`frustration-detector`。后者又在模块顶层读取输入、写状态并调用 `process.exit()`，
无法作为进程内 provider 安全加载。同时，记忆触发词没有覆盖“是否/有没有生效”类诊断问句。

## 已验证修复

1. `frustration-detector.cjs` 提供 require-safe 的 `retrieveContext(payload, deps)`，CLI
   逻辑只在 `require.main === module` 时执行。
2. `prompt-context.cjs` 在同一次 payload 解析中合并 rule、memory 与 frustration 三个
   provider，任一 provider 异常时保持 fail-open 隔离。
3. `memory-retrieve-hook.cjs` 只为“是否/有没有/未生效、启用、起作用”增加窄范围触发，
   没有放宽 candidate、scope、evidence 或 valid-until 信任过滤。

## 验证证据

- 行为命令：`node engine/scripts/test-hooks/prompt-context-contract.cjs`
- RED：同一命令退出 1，断言 `frustration context must be evaluated exactly once`，实际调用数为 0。
- GREEN：同一命令退出 0，输出 `PROMPT_CONTEXT_RESULT: PASS`。
- 兼容回归：`state-concurrency.cjs`、`read-only-hooks.cjs` 与
  `hook-manifest-contract.cjs` 均退出 0。

## 预防

- 新增或迁移认知 provider 时，必须覆盖单次 payload 复用、上下文合并、fail-open、
  require-safe 与只读模式无副作用。
- 不得通过 `includeCandidates` 或 `allowUnscoped` 让旧记忆绕过统一信任边界。

## 失效与复核

当 UserPromptSubmit payload、provider 输出格式、runtime-state、记忆触发或检索信任合同
发生变化时，将本条标记为 `needs_reverify` 并重跑上述行为命令；最迟在 `valid_until` 前复核。
