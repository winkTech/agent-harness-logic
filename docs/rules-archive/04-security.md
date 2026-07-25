---
name: security-rules
description: "安全准则 — 敏感操作审查"
priority: L2
trigger: "auth / token / password / secret / credential / payment / encrypt / SQL / XSS"
skip: "纯 RTL 编写 / 无安全敏感关键词"
---

# 安全准则

> L2 优先级：安全敏感场景按需加载。

## 禁止操作（硬拦截）
- `DROP TABLE` / `TRUNCATE` — hooks 拒绝，无反馈
- `rm -rf /` — hooks 拒绝

## 需要确认的操作
- `git push` — 需用户确认
- `git commit` — 需用户确认
- `git push --force` — 需用户明确确认
- `git reset --hard` — 需用户明确确认

## 安全敏感关键词
遇到安全敏感关键词时（详见 `rules/05-workflow-trigger.md` 的安全敏感关键词自动绑定），加载 `security-review` 工作流。
