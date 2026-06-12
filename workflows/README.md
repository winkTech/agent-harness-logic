# 工作流目录

> 这是 `rules/05-workflow-trigger.md` 引用的项目级工作流目录。
> 实际工作流脚本位于 `skills/workflows/` 目录下。

## 可用工作流

| 文件名 (skills/workflows/) | 用途 | 调用方式 |
|:--------------------------|:-----|:---------|
| `hdl-coding-dag-workflow.js` | HDL RTL 开发 DAG 工作流 v3.4 | `Workflow({name: 'hdl-coding-dag-workflow', args})` |
| `hdl-coding-workflow.md` | HDL 开发工作流定义（8 阶段） | 参考文档 |
| `code-review-workflow.md` | 代码审查工作流（2 轮） | `Workflow({name: 'code-review-workflow', args})` |
| `architecture-review-skill-workflow.md` | 架构审查 | `Workflow({name: 'architecture-review-workflow', args})` |
| `security-review-workflow.md` | 安全审查 | `Workflow({name: 'security-review-workflow', args})` |

## 添加新工作流

1. 将 `.js` 脚本放在 `skills/workflows/` 下
2. 在此文件添加引用
3. 在 `rules/05-workflow-trigger.md` 添加关键词映射
4. (可选) 在本目录创建快捷链接
