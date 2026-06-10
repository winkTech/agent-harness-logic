---
name: search-tools
description: "检索工具使用场景与优先级 — Grep/Glob/git log/rag-skill 的选择策略"
priority: L2
trigger: "搜索 / 查找 / 找 / search / find / grep / 查历史 / 记得有个"
skip: "纯代码编写 / 文件编辑 / 架构设计"
---

# 检索工具 — 使用场景与优先级

> L2 优先级：需要搜索代码/历史时按需加载。
> 按真实状态判断：搜索类操作触发时加载，不用时不占 context。

## 工具选择矩阵

| 目标 | 首选工具 | 备选 | 说明 |
|:-----|:---------|:-----|:------|
| 记忆检索 (经验/错误/教训) | **SQLite FTS5** (`memory-retrieve.sh`) | `memory/` grep | 自动从 37 条事实中 BM25 排序返回, 在 memory/ 和 knowledge/ 全文搜索 |
| 精确字段名/变量/信号 | `Grep` | — | 一个字都不差，速度最快 |
| 文件名/路径 | `Glob` | `Grep(路径)` | 模式匹配，支持 ** 递归 |
| 跨词同义搜索 | `rag-skill` 或 `code-search` | `Grep` 轮询 | "记得有个决策关于速率匹配…" |
| 调用链 / 谁调用谁 | `Grep(模块名)` | 读文件 port 定义 | SV 模块例化关系追查 |
| 谁何时改过某个文件 | `git log <文件>` | `git blame` | 历史追溯 |
| 知识库/领域知识 | `rag-skill` | `SQLite FTS5` | 优先走 rag-skill, FTS5 做补充 |

## 效率优先级

```
SQLite FTS5 (BM25 排序, 零 API) → Grep/Glob → git log → rag-skill(code-search) → 完整 Read
```

- 前三个都不需要 LLM 参与，直接返回结果
- 只有前三个都找不到时才 resort 到完整 Read 文件

## 注意事项

- 不要跨 3 个以上 `Grep` 还找不到就直接 `Read` — 换 `rag-skill` 或 `code-search`
- 读 400+ 行文件前先用 `Grep` 定位行号，再用 `Read offset/limit`
- `twiddle_1024_32b.v`（98KB 系数表）永远不 Read 全文
