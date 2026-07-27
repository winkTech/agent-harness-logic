---
name: core-rules
description: "Core routing bridge for persistent guidance and contextual rules."
priority: L0
trigger: "always"
skip: ""
---

# 核心规则路由

## 常驻契约

- Codex 的常驻行为契约由 `AGENTS.md` 提供，Claude Code 的常驻行为契约由 `CLAUDE.md` 提供。
- 本文件只向 Rule Loader 提供稳定路由，不重复授权、沟通、验证和停止规则，避免双重加权与内容漂移。
- 本目录 `docs/rules/` **不常驻**。放在 `.claude/rules/` 会被平台全文注入每个会话，
  与 Rule Loader 的 capsule 构成双重加权，正是上一条要避免的情况。

## 按需规则

- 新代码、新模块、新功能、接口或行为契约变化、正确行为不明：加载 `docs/rules/03-gates.md`。
- HDL、Testbench、FPGA/ASIC 架构或审查：加载 `docs/rules/01-hdl.md` 与 `hdl-coding`。
- Python：加载 `docs/rules/02-python.md`；Git：加载 `docs/rules/04-git.md`。
- 其他领域只加载与当前任务直接相关的 Skill 或规则，不扩展到无关流程。

## 加载纪律

- 使用 Rule Loader 返回的最窄规则集合；capsule 足够时不读取全文。
- 只有实现细节确实依赖某条规则时才读取对应全文，不批量加载规则目录。
