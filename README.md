# Claude Code Harness

你的 Claude Code 治理基础设施。管理规则约束、记忆、知识库、技能和工作流。

## 目录结构（按 5 层架构）

```
~/.claude/
├── CLAUDE.md       ← 核心指令（精简）
├── rules/          ← L1 边界：约束规则，渐进式披露
├── engine/         ← L1 边界：hooks + scripts + 工具链
├── memory/         ← L2 记忆：活跃记忆（失败经验 + 学习教训）
├── knowledge/      ← L2 记忆：领域知识 + 项目参考 + 文档
├── skills/         ← L5 技能：Skill + 工作流 + Agent 角色
└── var/            ← L3 交接：运行时状态（可清理）
```

## 快速入口

| 你要做的事 | 入口 |
|-----------|------|
| 理解核心规则 | `rules/00-core.md` |
| 查知识库 | 使用 `/rag-skill` |
| 添加 Skill | `skills/` 下新建目录 + `SKILL.md` |
| 修 Hook | `engine/hooks/` |
| 看看当前进度 | `var/work/` |
| 清理运行时 | `rm -rf var/*`（不会丢代码）|

## 维护

由 Claude Code 自动维护。遇到问题检查 `engine/hooks/` 日志。
