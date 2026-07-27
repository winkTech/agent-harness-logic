---
name: agent-management
description: Agent 生命周期管理 — 创建/编辑 Skill、发现安装社区 Skill、会话交接、子 Agent 编排执行
version: 1.0.0
model: sonnet
invoked_by: both
user_invocable: true
tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Agent Management

Agent 环境的全生命周期管理。三种模式：

| 模式 | 用途 |
|:----|:------|
| **Skill 管理** | 创建/编辑/优化 Skill，运行评估 |
| **Skill 发现** | 查找并安装社区 Skill |
| **会话管理** | 会话上下文交接、子 Agent 编排 |

---

## 模式 1：Skill 管理

创建新 Skill、修改已有 Skill、评估 Skill 性能。

```bash
# 创建 Skill
Skill({ skill: 'agent-management', args: 'create new skill for X' })

# 评估 Skill 性能
# 运行 eval → 基准测试 → 方差分析 → 优化描述
```

**适用**: 用户想创建新 Skill、修改优化已有 Skill、测试 Skill 触发精度。

## 模式 2：Skill 发现

当用户问"怎么做 X"、"有没有做 X 的 skill"、"能不能找一下做 X 的工具"时：

1. 搜索社区 Skill 生态
2. 推荐匹配的安装包
3. 执行安装

```bash
npx skills add <skill-name>
```

## 模式 3：会话管理

| 功能 | 说明 |
|:----|:------|
| **会话交接** | 长会话结束前将上下文和待办任务转移到新终端窗口 |
| **子 Agent 编排** | 按实施计划将独立任务分派给子 Agent，两阶段审查 |

**会话交接流程**:
1. 创建交接文档（记录当前状态、待办项）
2. 启动新终端窗口
3. 加载交接上下文

**子 Agent 编排**:
1. 将实施计划分解为独立任务
2. 每个任务派发一个子 Agent
3. 每个子 Agent 完成后执行两阶段审查（规范合规 → 代码质量）

## 参考文件

| 文件 | 内容 |
|:-----|:-----|
| `references/schemas.md` | skill-creator 使用的 JSON Schema —— 技能 evals 文件的字段定义与取值 |
