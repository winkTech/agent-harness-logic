---
name: context-management
description: "上下文管理规则 — 单窗口完成中大型项目的约束和策略"
priority: L1
trigger: "始终加载（与 00-core.md 同级）"
skip: "永不跳过"
---

# 上下文管理规则

> 在单对话窗口中完成中大型 FPGA/算法项目，必须主动管理上下文窗口。
> 违反硬约束 = 上下文失控，项目需要在 2+ 个 session 中拼接完成。

---

## 0. 核心指标

| 指标 | 估算公式 | 监控者 |
|:-----|:---------|:-------|
| **工具调用计数** | 每次 Grok/Read/Write/Edit = 1 次 | context-monitor hook |
| **权重估算** | Read/Write=3, Bash/Grok=2, Grep=1, 累加 | context-monitor hook |
| **转录文件大小** | var/sessions/*.jsonl | context-monitor-gate |
| **估算使用率** | max(调用计数/100, 权重/200, 文件KB/500) | 两 monitor 一致 |

---

## 一、硬约束 [MUST]

### H1: 50% 红线

> 估算使用率 **≥50%** 时，**必须 /compact** 后才能开始新任务。

- 允许完成当前正在进行的工具调用
- **禁止**：打开新文件、开始新阶段的编码、生成新 Agent
- **允许**：收尾当前修改、执行 `pre-compact save`、执行 `/compact`

**执行方式**：
- context-monitor-gate 在 ≥50% 时输出 "⚠️ 黄色预警"
- context-monitor hook 在 ≥40% 时首次预警，≥60% 橙色，≥80% 红色
- 检测到警告后，模型必须主动建议压缩或用户手动 `/compact`

### H2: 压缩前必须保存状态

> 执行 `/compact` 前，必须先执行 `pre-compact save` 保存关键上下文。

**自动执行**：`pre-compact.cjs` hook（low frequency，会话压缩前触发）

**保存内容**：
- 当前正在处理的模块/任务
- 关键设计决策（位宽选择、FSM 编码方式、架构取舍）
- 失败的尝试及其原因（避免压缩后重复试错）
- 待做事项列表

**手动触发**：
```bash
node engine/hooks/session/pre-compact.cjs save
```

### H3: 阶段制压缩

> 单窗口内完成整个项目 → 拆分为独立阶段，每个阶段完成后执行 `/compact`。

**自然阶段划分**：

```
FPGA 模块开发标准阶段:
  Phase 0: 架构设计/算法规格   → /compact
  Phase 1: 定点量化/Golden Model → /compact
  Phase 2: RTL编码              → /compact
  Phase 3: 仿真验证/TB          → /compact
  Phase 4: 顶层集成/综合        → /compact
```

**规则**：
- 阶段内部不压缩（除非触发 H1 红线）
- 阶段之间必须是硬壁垒：完成前一阶段所有产出后再压缩
- 压缩后第一阶段状态通过 `pre-compact read` 恢复

### H4: 无冗余读取

> 不读取当前阶段不需要的文件。已完成模块的源码不再保留在 context 中。

**替代方案**：
- 用 `grep` 定位信号/接口定义，代替完整 `Read`
- 用 `git diff` 查看改动，代替重新读取整个文件
- 用 `Glob` 确认文件存在，代替 `ls -la`

---

## 二、软约束 [SHOULD]

### S1: "已完成"日志

> 在每个 session 的 scratchpad 顶部维护结构化日志，作为压缩后唯一保留的信息。

**模板**：

```markdown
## 已完成
- [x] <模块/任务>: <状态>

## 关键决策
- <决策>: <原因>

## 失败记录
- <尝试>: <原因> → 放弃

## 待做 (按优先级)
- [ ] <下一步>
```

**规则**：
- `/compact` 前必须更新此日志
- 压缩后第一件事：读取上一阶段的日志
- 每个新阶段开始时，清理已完成的条目，只保留关键决策和历史失败

### S2: 上下文预算分配

> 单窗口估算预算 ≈ 100-120 次工具调用 / ~200 权重。

**按阶段分配**：

| 阶段类型 | 调用预算 | 权重预算 | 建议 |
|:---------|:---------|:---------|:-----|
| 分析/阅读 | ≤20 | ≤40 | 用 grep 替代 read |
| 编码 | ≤40 | ≤80 | 批量写入，少读多写 |
| 调试 | ≤30 | ≤60 | git diff 对比，不重复读 |
| 验证/收尾 | ≤10 | ≤20 | 轻量检查 |

**超预算处理**：
- 阶段内超预算 → 提前 `/compact`，阶段结束
- 到达 50% 红线但阶段未完 → 先 compact，在下一轮继续

### S3: 批量处理原则

```
读取文件: 一次 Read 多文件 > 多次 Read 单文件
工具调用: 合并相关操作 > 分散调用
搜索查询: 宽匹配后过滤 > 多次精确搜索
代码修改: 完整模块写入 > 逐行 Edit
```

### S4: 自压缩提示

> 当前模型应每 ~20 次工具调用后自检。

**自检清单**：
1. ✅ "已完成"日志是否已更新？
2. ✅ 还有没有追踪已解决的问题？
3. ✅ 有什么中间结果可以丢弃？
4. ✅ 压缩后什么信息必须保留？

---

## 三、监控工具参考

```bash
# 查看当前 context 状态
node engine/scripts/context-monitor-gate.cjs --status

# 查看 context-monitor hook 状态
node engine/hooks/safety/context-monitor.cjs status

# 保存压缩前状态
node engine/hooks/session/pre-compact.cjs save

# 读取压缩前状态
node engine/hooks/session/pre-compact.cjs read

# 重置 context-monitor 计数器
node engine/hooks/safety/context-monitor.cjs reset
```

---

## 四、违反后果

| 违反 | 后果 |
|:-----|:------|
| 超过 50% 红线不压缩 | context 溢出 → 幻觉/质量下降 → 需要新 session 重做 |
| 压缩前不保存状态 | 关键决策丢失 → 在压缩后 session 中重新讨论 |
| 跨阶段不压缩 | context 积累超载 → 被迫在阶段中压缩 → 丢失上下文连贯性 |
| 冗余读取 | 浪费 context 预算 → 提前触发红线 → 频繁中断 |
