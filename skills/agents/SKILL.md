---
name: agents
description: Agent 定义文件 — 供 Harness 调用的预定义 Agent 角色
---

# Agents 技能目录

本目录存放预定义的 Agent 角色定义文件。每个 .md 文件定义一个可被 Workflow 调用的 Agent 角色。

## 目录结构
- core/ — 核心 Agent 定义
- domain/ — 领域专用 Agent 定义
- orchestrators/ — 编排器 Agent 定义
- specialized/ — 专用 Agent 定义

## 使用方式
在 Workflow 中通过 agentType 参数引用：
```
agent(prompt, { agentType: 'architect' })
```
