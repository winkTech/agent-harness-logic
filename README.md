# Claude Code Harness

你的 Claude Code 治理基础设施。管理规则约束、记忆、知识库、技能和工作流。

## 目录结构（按 5 层架构）

```
~/.claude/
├── CLAUDE.md       ← 核心指令（精简）
├── rules/          ← L1 边界：约束规则，渐进式披露
├── engine/         ← L1 边界：hooks + scripts + 工具链
│   ├── hooks/      ←   本地 hook 脚本（pre-commit-lint / diff-size-gate / frustration-detector 等）
│   └── scripts/    ←   引擎脚本（semantic-search / code-graph / runtime-state / memory-retrieve 等）
├── memory/         ← L2 记忆：活跃记忆（失败经验 + 学习教训）
├── knowledge/      ← L2 记忆：领域知识 + 项目参考 + 文档
│   ├── primary/    ←   核心领域知识（FPGA / Python / MATLAB）
│   ├── docs/       ←   技术文档与模板
│   └── references/ ←   参考资料索引（含 skills-catalog）
├── var/            ← L3 交接：运行时状态（可清理）
│   ├── index/      ←   语义搜索索引 + 代码图谱 + 运行时状态 JSON
│   ├── active-task.yaml  ← 任务协议（交接层核心）
│   ├── work/       ←   session 工作记忆
│   └── sessions/   ←   session 快照
├── skills/         ← L5 技能：Skill + 工作流 + Agent 角色
└── rules/
    └── 06-cognition.md  ← L4 认知层：7 种推理模式定义
```

## 四工具检索（L2 记忆层）

| 工具 | 场景 | 覆盖域 |
|:-----|:-----|:-------|
| `grep` | 精确字段名 / URL / 环境变量 | 字面量搜索 |
| `semantic-search` | 跨词同义 / 概念召回 / "记得有个决策" | TF-IDF char n-gram |
| `code-graph` | 调用链 / import 关系 / 模块实例 | 代码结构 |
| `git log` | 谁何时改过 / 时间轴查询 | 版本历史 |

四工具覆盖域 0 重叠，每个场景只有一个正确工具。

## 七种推理模式（L4 认知层）

见 `rules/06-cognition.md` — 根因分析 / 第一性原理 / 减法 / 搜索优先 / 倒推 / 证据驱动 / 闭环。

挫败关键词自动检测 + 模式切换注入（由 `frustration-detector` hook 实现）。

## 快速入口

| 你要做的事 | 入口 |
|-----------|------|
| 理解核心规则 | `rules/00-core.md` |
| 查知识库 | 使用 `/rag-skill` |
| 查技能列表 | `knowledge/references/skills-catalog.md` |
| 看当前进度 | `var/active-task.yaml` |
| 新 session 开局 | `/start` |
| Session 收尾 | `/handoff` |
| 清理运行时 | `rm -rf var/*`（不会丢代码）|

## 维护

由 Claude Code 自动维护。遇到问题检查 `engine/hooks/` 日志。
