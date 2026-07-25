---
name: reference-index
description: 参考资料索引
metadata:
  type: reference
---

# 参考资料索引

> CLAUDE.md 中提到的所有 reference 文档路径。按需加载，不占用启动 token。

---

## 系统与 Agent

| 文档 | 内容 |
|:----|:-----|
| `knowledge/references/agent-harness.md` | Agent 循环、权限、钩子、压缩、记忆、任务图 |
| `knowledge/references/memory-system.md` | 记忆系统规则：工作记忆/错误经验/学习总结 |

## 会话与错误恢复

| 文档 | 内容 |
|:----|:-----|
| `knowledge/references/session-management.md` | 会话监控、超载应对、恢复策略 |
| `knowledge/references/error-recovery.md` | 错误分类、恢复指南、止损流程 |
| `knowledge/references/performance-baseline.md` | 性能基准、预期指标 |
| `knowledge/references/tool-scripts.md` | 工具脚本说明 |

## 插件与版本

| 文档 | 内容 |
|:----|:-----|
| `knowledge/references/plugin-management.md` | 插件配置与管理 |
| `knowledge/references/new-plugins.md` | 新接入插件说明 |
| `knowledge/references/version-rules.md` | 版本管理规则 |

## 高级功能与 Skill

| 文档 | 内容 |
|:----|:-----|
| `knowledge/references/advanced-features.md` | 高级功能配置 |
| `knowledge/references/skills-catalog.md` | Skill 完整目录（含所有注册 Skill） |

## HDL 编码参考

| 文档 | 内容 |
|:----|:-----|
| `skills/hdl-coding/SKILL.md` | HDL 编码 Skill 定义 |
| `skills/hdl-coding/references/rtl-code-review.md` | RTL 代码审查规范 |
| `skills/hdl-coding/references/timing-constraints.md` | 时序约束 |
| `skills/hdl-coding/references/fpga-optimization.md` | FPGA 优化 |
| `skills/hdl-coding/references/alg-flow-verilog.md` | 算法→Verilog 代码模板（流程见 hdl-coding-workflow） |

## 工作流

> 渐进式披露结构：骨架文件是快速索引，子文件包含详细内容，按需加载。

| 骨架 | 子文件 | 内容 |
|:-----|:-------|:-----|
| `skills/workflows/hdl-coding-workflow.md` | `skills/workflows/hdl-coding/` (10 个 Phase) | RTL 开发全流程 v3.4 — 架构→定点→TB+向量生成→逐模块RTL+脚本化对比→证据门禁→顶层全链仿真→回归→审查→报告 |
| `skills/workflows/code-review-workflow.md` | `skills/workflows/code-review/` (2 个 Pass) | 两轮代码审查：正确性→代码质量 |
| `skills/workflows/architecture-review-skill-workflow.md` | `skills/workflows/architecture-review/` (4 个 Phase) | 多 Agent 架构审查：上下文→分析→安全→建议 |
| `skills/workflows/rag-skill-workflow.md` | — | 知识库检索流程（66 行，无需拆分） |
| `skills/workflows/security-review-workflow.md` | — | 安全审查流程（97 行，无需拆分） |

## 工具链

| 文档 | 内容 |
|:----|:-----|
| `knowledge/references/mcp-matlab-usage.md` | MATLAB MCP 使用指南 |
| `skills/tdd/references/tdd-workflow-local.md` | TDD 工作流 |
| `skills/rag-skill/references/pdf_reading.md` | PDF 文档读取 |

## Agent 上下文管理

| 脚本 | 用途 |
|:----|:-----|
| `engine/scripts/agent-context-budget.cjs` | 逐 Agent 类型上下文预算（tight/normal/relaxed/full 四档）+ 智能压缩 |
| `engine/scripts/agent-context-watchdog.cjs` | Agent spawn 追踪 + 自压缩指令注入 + context 统计报表 |
| `engine/scripts/ctx-checkpoint.sh` | PreCompact hook 调用的压缩前 checkpoint |
| `engine/scripts/runtime-state.cjs` | 运行时状态管理器（含 spawnedAgents 列表） |

使用方式：
```bash
# 查 developer agent 的预算
node engine/scripts/agent-context-budget.cjs tier developer

# 从 stdin 压缩 prompt
cat prompt.txt | node engine/scripts/agent-context-budget.cjs compress developer

# 查 agent 上下文健康摘要
node engine/scripts/agent-context-watchdog.cjs health

# 记录 agent spawn
node engine/scripts/agent-context-watchdog.cjs track planner

# 查看所有已 spawn agent
node engine/scripts/agent-context-watchdog.cjs status
```
