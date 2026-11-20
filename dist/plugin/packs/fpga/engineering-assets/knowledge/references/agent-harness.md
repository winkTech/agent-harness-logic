---
name: agent-harness
description: Agent Harness 核心机制
metadata:
  type: reference
---

# Agent Harness 核心机制

> 来源: fpga-agent-harness + learn-claude-code
> 用途: 理解 Agent 工作原理，优化配置

---

## 核心循环 (Agent Loop)

```
用户输入 → messages[] → LLM → 响应
                              ↓
                    stop_reason == "tool_use"?
                   /                          \
                 是                           否
                  ↓                             ↓
            执行工具                        返回文本
            追加结果
            循环返回 → messages[]
```

**关键点**: 循环本身不变，工具、知识、权限通过 harness 注入

---

## 工具分发 (Tool Dispatch)

| 机制 | 作用 |
|------|------|
| 工具注册 | 定义可用工具列表 |
| 参数验证 | 检查工具参数格式 |
| 执行分发 | 调用对应工具函数 |
| 结果格式化 | 统一返回格式 |

---

## 权限系统 (Permission)

**规则结构**:
```yaml
- name: 规则名称
  tool_pattern: 工具名模式 (支持 * 通配符)
  input_pattern: 输入模式 (正则)
  action: allow/deny/ask
  description: 规则说明
```

**默认规则**:
- 阻止危险命令: `rm -rf /`, `sudo`, `shutdown`
- 阻止路径逃逸: `../`

---

## 钩子系统 (Hooks)

**钩子类型**:
| 类型 | 触发时机 | 用途 |
|------|----------|------|
| PreToolUse | 工具执行前 | 验证、阻止、修改参数 |
| PostToolUse | 工具执行后 | 日志、清理、后处理 |
| PreLLMCall | LLM 调用前 | 修改消息、注入上下文 |
| PostLLMCall | LLM 调用后 | 处理响应 |
| OnError | 错误发生时 | 恢复策略 |

**设计原则**: 钩子围绕循环，不重写循环

---

## 上下文压缩 (Context Compact)

**多层策略**:

| 层级 | 方法 | 触发条件 |
|------|------|----------|
| 微压缩 | 清除旧工具结果 | 工具结果 > N 个 |
| 自动压缩 | LLM 总结历史 | token > 阈值 |

**微压缩规则**:
- 只保留最近 N 个工具结果
- 旧结果替换为 `[cleared]`

**自动压缩规则**:
- 取最后 20 条消息总结
- 返回压缩后的摘要

---

## 记忆系统 (Memory)

**三个子系统**:

| 子系统 | 功能 |
|--------|------|
| 选择 | 决定记住什么 |
| 提取 | 从对话中提取信息 |
| 巩固 | 长期保存重要信息 |

**记忆操作**:
- `remember(key, content, category)` — 记住
- `recall(key)` — 回忆
- `forget(key)` — 忘记
- `search(query)` — 搜索

---

## 任务图 (Task Graph)

**任务状态**:
```
pending → in_progress → completed
                       ↓
                    deleted
```

**依赖管理**:
- 任务可依赖其他任务
- 被依赖任务完成后自动解锁
- 支持多 agent 协作

---

## 错误恢复 (Error Recovery)

**恢复策略**:

| 策略 | 处理场景 | 方法 |
|------|----------|------|
| 网络重试 | 超时、网络错误 | 指数退避 |
| Token 升级 | Token 限制 | 增加 max_tokens |
| Fallback | 模型不可用 | 切换备用模型 |

**指数退避公式**:
```
delay = base_delay * (2 ^ retry_count)
```

---

## 与 Claude Code 的映射

| Harness 机制 | Claude Code 对应 |
|--------------|------------------|
| Agent Loop | 内置循环 |
| Tool Dispatch | 工具系统 |
| Permission | permissions 配置 |
| Hooks | .githooks/ + 插件 hooks |
| TodoWrite | TodoWrite 工具 |
| Subagent | Agent 工具 |
| Skill Loading | Skill 系统 |
| Context Compact | /compact 命令 |
| Memory | ~/.claude/memory/ |
| Task Graph | TodoWrite + 文件 |
| Error Recovery | 内置重试 |

---

## 最佳实践

1. **权限最小化**: 只允许必要的工具调用
2. **钩子分层**: 安全检查 → 日志 → 后处理
3. **记忆分类**: work/error/learning 分开存储
4. **任务分解**: 大目标拆分为小任务
5. **错误处理**: 重试 → 降级 → 报告
