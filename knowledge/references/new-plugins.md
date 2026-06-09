# 新插件详细说明

> coding-tutor、compound-engineering 详细配置

---

## coding-tutor（编程教程）

**功能**: 个性化编程教程，使用实际代码库作为示例，支持间隔重复测验

**使用场景**:
- 学习新编程概念
- 通过实际代码示例加深理解
- 间隔重复测验巩固知识

**调用方式**:
- `/teach-me` - 学习新内容
- `/quiz-me` - 测验巩固

**特点**:
- 使用当前代码库作为示例
- 根据学习者背景定制内容
- 维护持久化学习记录
- 支持间隔重复算法

---

## compound-engineering（复合工程）

**功能**: AI 驱动的开发工具，用于代码审查、研究、设计和工作流自动化

**核心 Skills**:

| Skill | 功能 | 场景 |
|-------|------|------|
| `ce-work` | 工作执行 | 执行计划、完成任务 |
| `ce-plan` | 计划制定 | 制定工作计划 |
| `ce-brainstorm` | 头脑风暴 | 多方案对比 |
| `ce-code-review` | 代码审查 | 代码质量检查 |
| `ce-debug` | 调试 | 问题排查 |
| `ce-commit` | 提交 | 代码提交 |
| `ce-commit-push-pr` | 提交推送PR | 完整 Git 工作流 |
| `ce-simplify-code` | 简化代码 | 代码重构 |
| `ce-optimize` | 优化 | 性能优化 |
| `ce-frontend-design` | 前端设计 | UI/UX 设计 |
| `ce-agent-native-architecture` | Agent 架构 | AI Agent 设计 |
| `ce-sessions` | 会话管理 | 会话交接 |
| `ce-worktree` | 工作树 | Git worktree 管理 |

**使用示例**:
```bash
# 执行工作
/ce-work [计划文档路径或工作描述]

# 制定计划
/ce-plan [功能描述]

# 代码审查
/ce-code-review [文件或目录]

# 头脑风暴
/ce-brainstorm [问题描述]
```

**特点**:
- 工作流自动化
- 多阶段任务执行
- 代码质量保证
- 知识管理
