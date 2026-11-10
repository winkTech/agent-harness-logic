---
name: codegraph-distillation
description: "CodeGraph 蒸馏集成到 Harness 的实现记录 — 2026-06-21"
metadata:
  type: project
---

# CodeGraph 蒸馏集成到 Harness

## 背景

将 CodeGraph 的语义代码智能能力提炼到 Claude Code Harness 中。CodeGraph 的核心价值是 **AST 级符号图 + 图遍历 + "Explore-flow"**（一次调用替代 10+ 次 Read/Grep）。

## 重叠审查与融合决策

| 计划 | 已有 | 重叠 | 决策 |
|:-----|:-----|:------|:------|
| `cg-indexer.cjs` | `code-graph-index.cjs` | 🔴 高 | **不创建**，重构现有 |
| `cg-retrieve-hook.cjs` | `memory-retrieve-hook.cjs` | 🟠 中 | **不创建**，增强现有 |
| `cg-cli.cjs` | `code-graph-index.cjs` | 🔴 高 | **不创建**，扩展现有 CLI |
| `python-cg.cjs` | `code-graph-index.cjs` | 🟡 低 | **不创建**，已有实现 |

**融合原则**: 重构现有 → 扩展 → 最后才新建。避免功能碎片化。

## 最终交付物

**新建 4 个文件**：
- `engine/sqlite/migrations/003-codegraph.cjs` — 6 表 + FTS5 + 触发器
- `engine/parsers/sv-codegraph.cjs` — 增强 SV 解析器（模块/端口/参数/信号/实例/always/assign）
- `engine/scripts/cg-queries.cjs` — 查询库（MCP+CLI 共用），含递归 CTE 图遍历
- `engine/mcp/codegraph-server.cjs` — MCP stdio 服务器，5 个工具

**增强 6 个已有文件**：
- `engine/scripts/code-graph-index.cjs` — JSON→SQLite，加项目参数+增量同步+跨文件引用解析
- `engine/scripts/memory-retrieve-hook.cjs` — 加代码触发词，融合代码图检索
- `engine/scripts/memory-retrieve.sh` — tool #3 改用 SQLite 后端
- `rules/09-search-tools.md` — 加代码图优先级
- `.mcp.json` — 注册 codegraph MCP 服务
- `settings.local.json` — 无需修改（已有 `mcp__*` 匹配器自动覆盖）

## 核心指标

测试项目（OFDM WiFi PHY，296 个 SV 文件）：
- 2255 符号（104 模块 + 1383 信号 + 218 always + 210 assign + 190 参数 + 82 实例）
- 2307 关系边（含跨文件解析的 79 个实例→模块链接）
- 首次索引 11s，增量同步 0.1s

## MCP 工具矩阵

| 工具 | 用途 | CodeGraph 对应 |
|:----|:-----|:---------------|
| `harness_cg_explore` | 符号袋搜索+源码+关系 | `codegraph_explore` |
| `harness_cg_node` | 符号体+调用者/被调用者轨迹 | `codegraph_node` |
| `harness_cg_search` | FTS5 符号搜索 | `codegraph_search` |
| `harness_cg_callers` | 谁实例化/调用此模块 | `codegraph_callers` |
| `harness_cg_callees` | 此模块实例化了什么 | `codegraph_callees` |

## 关键教训

1. **重叠审查先行**: 原始方案计划创建 12 个新文件+5 个修改，经审查融合后减为 4 新建+6 增强。
2. **递归遍历的 files 参数**: `walkProject` 最初忘记传递 files 数组，导致只扫描了根目录。
3. **跨文件引用解析**: SV 模块的例化关系需要解析步骤——实例节点→模块定义节点的边不是从单文件解析中自然产生的。
4. **FTS5 回退策略**: 纯中文查询需要 LIKE 回退（unicode61 tokenizer 对中文分词不稳定）。
