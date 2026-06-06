# 参考资料索引

> CLAUDE.md 中提到的所有 reference 文档路径。按需加载，不占用启动 token。

---

## 系统与 Agent

| 文档 | 内容 |
|:----|:-----|
| `agent-harness.md` | Agent 循环、权限、钩子、压缩、记忆、任务图 |
| `memory-system.md` | 记忆系统规则：工作记忆/错误经验/学习总结 |

## 会话与错误恢复

| 文档 | 内容 |
|:----|:-----|
| `session-management.md` | 会话监控、超载应对、恢复策略 |
| `error-recovery.md` | 错误分类、恢复指南、止损流程 |
| `performance-baseline.md` | 性能基准、预期指标 |
| `tool-scripts.md` | 工具脚本说明 |

## 插件与版本

| 文档 | 内容 |
|:----|:-----|
| `plugin-management.md` | 插件配置与管理 |
| `new-plugins.md` | 新接入插件说明 |
| `version-rules.md` | 版本管理规则 |

## 高级功能与 Skill

| 文档 | 内容 |
|:----|:-----|
| `advanced-features.md` | 高级功能配置 |
| `skills-catalog.md` | Skill 完整目录（含所有注册 Skill） |

## HDL 编码参考

| 文档 | 内容 |
|:----|:-----|
| `hdl-coding/SKILL.md` | HDL 编码 Skill 定义 |
| `hdl-coding/references/rtl-code-review.md` | RTL 代码审查规范 |
| `hdl-coding/references/timing-constraints.md` | 时序约束 |
| `hdl-coding/references/fpga-optimization.md` | FPGA 优化 |
| `hdl-coding/references/alg-flow-verilog.md` | 算法→Verilog 代码模板（流程见 hdl-coding-workflow） |

## 工作流

> 渐进式披露结构：骨架文件是快速索引，子文件包含详细内容，按需加载。

| 骨架 | 子文件 | 内容 |
|:-----|:-------|:-----|
| `workflows/hdl-coding-workflow.md` | `workflows/hdl-coding/` (8 个 Phase) | RTL 开发全流程 — 算法分析→架构→定点→TB→RTL→回归→审查→报告 |
| `workflows/code-review-workflow.md` | `workflows/code-review/` (2 个 Pass) | 两轮代码审查：正确性→代码质量 |
| `workflows/architecture-review-workflow.md` | `workflows/architecture-review/` (4 个 Phase) | 多 Agent 架构审查：上下文→分析→安全→建议 |
| `workflows/rag-skill-workflow.md` | — | 知识库检索流程（66 行，无需拆分） |
| `workflows/security-review-workflow.md` | — | 安全审查流程（97 行，无需拆分） |

## 工具链

| 文档 | 内容 |
|:----|:-----|
| `mcp-matlab-usage.md` | MATLAB MCP 使用指南 |
| `tdd/references/tdd-workflow-local.md` | TDD 工作流 |
| `rag-skill/references/pdf_reading.md` | PDF 文档读取 |
