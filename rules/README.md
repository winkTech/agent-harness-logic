# rules/ 目录说明

本目录存放按优先级分层加载的规则文件，供 Claude Code 工作框架使用。

## frontmatter `priority` 字段含义

| 优先级 | 加载机制 | 示例文件 | 说明 |
|:-------|:---------|:---------|:-----|
| **L0** | 始终自动加载，不可跳过 | `00-core.md` | 全局基础规则，每个 session 启动时注入 |
| **L1** | 按文件类型自动加载 | `01-hdl.md` (.sv/.v), `02-python.md` (.py) | 检测到对应语言/工具链时自动附加 |
| **L2** | 按场景关键词触发加载 | `03-debugging.md`, `04-security.md`, `07-system.md`, `08-constraints.md`, `09-search-tools.md`, `10-drawing.md` | 命中特定关键词（如"安装"、"搜索"、"画图"）时按需加载 |
| **L3** | 按工作流触发加载 | `05-workflow-trigger.md`, `12-tdd.md` | 在工作流或特定 action 执行时加载 |

> **注意**：`priority` 表示**加载时机**（何时注入到 context），而非规则约束力。约束力在各文件正文中另行说明（如 `08-constraints.md` 标注"约束力最高"）。L0 文件（始终加载）不一定约束力最高，反之亦然。
