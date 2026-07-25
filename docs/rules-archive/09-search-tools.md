---
name: search-tools
description: "检索工具使用场景与优先级 — 代码图/Grep/Glob/git log/rag-skill 的选择策略"
priority: L2
trigger: "搜索 / 查找 / 找 / search / find / grep / 查历史 / 记得有个 / 模块 / 符号 / 调用"
skip: "纯代码编写 / 文件编辑 / 架构设计"
---

# 检索工具 — 使用场景与优先级

> L2 优先级：需要搜索代码/历史时按需加载。
> 按真实状态判断：搜索类操作触发时加载，不用时不占 context。

## 工具选择矩阵

| 目标 | 首选工具 | 备选 | 说明 |
|:-----|:---------|:-----|:------|
| 记忆检索 (经验/错误/教训) | **SQLite FTS5** (`memory-retrieve.sh`) | `memory/` grep | 自动从事实表中 BM25 排序返回 |
| 精确字段名/变量/信号 | `Grep` | — | 一个字都不差，速度最快 |
| 文件名/路径 | `Glob` | `Grep(路径)` | 模式匹配，支持 ** 递归 |
| 跨词同义搜索 | `rag-skill` 或 `code-search` | 代码图 FTS5 | "记得有个决策关于速率匹配…" |
| 调用链 / 模块层次结构 | **`harness_cg_explore`** | `harness_cg_node` + 其他 | 一个调用获取符号+源码+关系（主入口） |
| 模块定义/端口 | **`harness_cg_node`** | Read | 符号体+调用者/被调用者轨迹 |
| 谁实例化了模块X | **`harness_cg_callers`** | Grep(模块名) | 所有实例化站点的完整列表 |
| 模块X实例化了什么 | **`harness_cg_callees`** | Read 文件 | 子模块依赖关系 |
| 代码符号模糊搜索 | **`harness_cg_search`** | Grep | FTS5 模糊+前缀匹配 |
| 架构/重构影响分析 | **`harness_cg_explore`** | 组合代码图工具 | 一个调用完成符号关系全览 |
| 谁何时改过某个文件 | `git log <文件>` | `git blame` | 历史追溯 |
| 知识库/领域知识 | `rag-skill` | `SQLite FTS5` | 优先走 rag-skill, FTS5 做补充 |

## 效率优先级

```
harness_cg_explore（一站式）→ harness_cg_search（快速符号）
→ SQLite FTS5（知识检索）→ Grep/Glob → git log → rag-skill → 完整 Read
```

第一选择始终是 `harness_cg_explore`，因为它在一次调用中提供了源码+关系，
通常在 1-3 次调用中消除 10+ 次 Read 或 Grep 操作。

## 注意事项

- 不要跨 3 个以上 `Grep` 还找不到就直接 `Read` — 换 `rag-skill` 或代码图搜索
- 代码图工具自动索引项目（索引一次后增量同步），首次使用可能需要先 `code-graph-index.cjs index /project/path`
- 读 400+ 行文件前先用 `Grep` 定位行号，再用 `Read offset/limit`
- `twiddle_1024_32b.v`（98KB 系数表）永远不 Read 全文
