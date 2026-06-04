---
name: doc-gen
description: 文档生成 — 从代码/API/需求生成文档、README、开发者指南、架构文档、用户手册
version: 1.0.0
model: sonnet
invoked_by: both
user_invocable: true
tools: [Read, Write, Edit, Glob, Grep]
---

# Doc Gen

从代码、API 和规约生成结构化文档。两种模式：

| 模式 | 用途 | 输出格式 |
|:----|:-----|:---------|
| **README** | 项目 README 生成与更新 | Markdown |
| **全文档** | API 文档/开发者指南/架构文档/用户手册 | Markdown + OpenAPI |

## README 模式

生成标准 README 结构：

```markdown
# 项目名
- 简介
- 快速开始
- API/使用说明
- 架构概览
- 贡献指南
- 许可证
```

**准则**: 提取代码注释生成接口文档，包含示例和故障排查指南。

## 全文档模式

| 模板 | 适用 |
|:----|:-----|
| API 文档 | OpenAPI/Swagger，含请求/响应示例 |
| 开发者指南 | 环境搭建、架构说明、工作流 |
| 架构文档 | 组件图、数据流、决策记录 |
| 用户手册 | 安装、配置、使用、FAQ |

## 反模式

| 反模式 | 正确做法 |
|:------|:---------|
| 文档与代码脱节 | 从代码注释/接口定义自动生成 |
| 无示例无教程 | 每个 API/功能配可运行示例 |
| 跳过故障排查 | 为常见错误写调试指南 |

## 关联 Skill

- [code-search](../code-search/SKILL.md) — 搜索代码提取文档素材
