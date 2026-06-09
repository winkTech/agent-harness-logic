# Claude Code 配置 v4.0

## 约束（L0，必须读）
- 通用：四条铁律 + Lint First + 验证闭环 → `rules/00-core.md`
- 安全：禁止操作 + 需确认项 → `rules/04-security.md`
- 按上下文自动加载：HDL(`01-hdl.md`)、Python(`02-python.md`)、调试(`03-debugging.md`)

## 认知层（L4）
遇到挫败/绕圈时自动切换 7 种推理模式：
根因分析 / 第一性原理 / 减法 / 搜索优先 / 倒推 / 证据驱动 / 闭环
→ `rules/06-cognition.md`，`runtime-state.cjs` 持久化模式状态

## 检索（L2 四工具）
| 工具 | 场景 |
|:-----|:-----|
| `grep` | 精确字段名 / 字面量 |
| `semantic-search` | 跨词同义 / "记得有个决策" |
| `code-graph` | 调用链 / import 关系 |
| `git log` | 谁何时改过 |

## 技能

| Skill | 场景 |
|-------|------|
| `/start` | 新 session 开局（读任务协议 + git 状态 → Briefing） |
| `/handoff` | session 收尾（保存进度 + 写日志 + 更新任务协议） |
| `/project-init` | FPGA 项目/模块脚手架 |
| `/hdl-coding` | RTL 编写、Testbench |
| `/rtl-gen` | RTL 快速代码生成 |
| `/tdd` | 测试驱动开发 |
| `/code-review` | 代码审查 |
| `/debugging` | 系统化调试 |
| `/rag-skill` | 知识库检索 |
| `/code-search` | 统一代码搜索 |
| `/git-expert` | Git 操作 |
| `/python-hardware-debug` | 星座图/EVM/频偏分析 |
| `/doc-gen` | 文档生成 |
| 完整列表 | → `knowledge/references/skills-catalog.md` |

| MCP | 触发 |
|:----|:-----|
| matlab | .m 文件、golden model、定点化 |
| mcp-pdf | PDF 文档操作 |

## 工作流触发
用户关键词 → 对应工作流。详见 `rules/05-workflow-trigger.md`。

## 参考
- `knowledge/references/reference-index.md` — 完整索引
- `knowledge/references/skills-catalog.md` — 全部技能/工作流目录
- `knowledge/INDEX.md` — 知识库（优先使用 rag-skill 检索）

## 版本
v4.0 (2026-06-09): 目录重构 + 五层架构（边界/记忆/交接/认知/技能）
