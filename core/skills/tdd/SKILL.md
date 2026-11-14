---
name: tdd
description: 测试驱动开发 — RED/GREEN/REFACTOR 循环。先写测试 → 证明失败 → 最小实现 → 重构。
version: 1.4.0
model: sonnet
invoked_by: both
user_invocable: true
tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# TDD — 测试驱动开发

## 何时用

- 任何生产代码变更
- Bug 修复（先写失败测试证明 bug）
- 新功能实现
- **不使用**：纯文档/注释修改

## 铁律

1. **未证明 RED 之前不写实现代码** — 没有 RED 阶段的 GREEN 是假 GREEN。
2. **最小 GREEN 补丁** — 只够让当前失败测试通过，不多写一行。
3. **一次一个 scenario** — 完成一个 scenario 的 RED→GREEN→REFACTOR 全循环后，再进入下一个。
4. **测试不加 try/catch，不 hack 断言（`ok(true)`）** — 测试必须能真实验证代码行为。
5. **重构阶段只改结构不改行为** — 重构后所有测试必须仍为 GREEN。

---

## Canon Loop

### Step 0: 创建/刷新场景列表

```bash
# 列出已有测试，识别待办场景
grep -rn "describe\b\|it\b\|test\b" --include="*.test.*" --include="*_test.*" . | head -40
# 写入 .claude/context/tmp/tdd-scenarios-{session}.md
```

### Step 1: 选一个场景，写一个可运行的测试

写测试前必须：
1. `pnpm search:structure`（如果还没跑）— 了解目录结构
2. 确认测试框架（node:test / Vitest / pytest / unittest）
3. 写最小测试文件

### Step 2: 证明 RED

```bash
# 运行刚写的测试，确认它失败
pnpm test -- --grep "test-name"
# 保存失败输出到 terminal 日志作为 RED 证据
```

**RED 证据不可跳过。** 如果测试意外通过 → 要么测试有问题，要么功能已经存在。

### Step 3: 最小 GREEN 补丁

- 只实现让当前测试通过的最少代码
- 不允许"顺手重构"或"多实现一点"
- 魔数/常量可以先硬编码（Step 5 再提取）

### Step 4: 证明 GREEN

```bash
# 同一条命令，预期通过
pnpm test -- --grep "test-name"
```

验证后检查：
- 测试本身是合法的（没有 try/catch 消化失败、没有 `ok(true)` 欺骗）
- 可以用 mutation testing 确认（参见 `references/mutation-testing.md`）

### Step 5: 可选重构

- 提取常量、消除重复、改善命名
- 重构后所有测试仍为 GREEN
- **不改行为，只改结构**

### Step 5.5: 属性基测试（推荐）

对工具函数和安全钩子使用 property-based testing：
参见 `references/property-based-testing.md`

### Step 6: 重复直到场景列表为空

---

## 高级功能（按需阅读）

| 功能 | 文档 | 适用场景 |
|:----|:-----|:---------|
| 🔄 自主 TDD 循环 | `references/ralph-loop.md` | 长时间无人值守迭代 |
| 👥 多 Agent TDD 分解 | `references/multi-agent-tdd.md` | 大型功能多 Agent 并行 |
| 🧪 变异测试 | `references/mutation-testing.md` | 验证测试质量（防假 GREEN） |
| 📡 MSW HTTP Mocking | `references/http-mocking.md` | API 边界测试 |
| 🧬 Contract Testing (hooks) | `references/contract-testing.md` | Hook 边界契约测试 |
| 📝 TDP Prompting | `references/test-driven-prompting.md` | AI 输出的分数式断言 |
| 🧠 记忆加速层 | `references/memory-acceleration.md` | 跨会话测试场景追踪 |
| 🏗️ Agent-Studio 扩展 | `references/agent-studio-extensions.md` | Hook 测试 / 记忆 TDD |
| 🧪 测试运行器选择 | `references/test-runner-selection.md` | node:test vs Vitest vs pytest |
| 🗂️ 本地 TDD 工作流 | `references/tdd-workflow-local.md` | 本仓库落地的具体步骤 |
| 🧷 记忆画像 | `references/tdd-memory-profile.md` | 记忆层字段与写入时机 |
| 📚 方法论溯源 | `references/research-requirements.md` | Canon TDD + arXiv 证据与硬约束 |
| 📋 变更实施模板 | `templates/implementation-template.md` | 场景清单 + 逐轮 RED/GREEN 证据表 |

---

## 验证清单

- [ ] Step 0: 场景列表面向用户可见
- [ ] Step 2: RED 证据已保存（终端输出或文件）
- [ ] Step 4: GREEN 证明且测试无 hack
- [ ] 没有跳过重构阶段的"技术债累积"
- [ ] 测试覆盖边界和错误路径

## 反模式

| 反模式 | 正确做法 |
|:------|:---------|
| 不证明 RED 直接写实现 | 先跑失败测试，确认测试有效 |
| 一次实现多个功能 | 一个 scenario 一个循环 |
| 测试用 try/catch 消化错误 | 测试必须能真实验证行为 |
| 重构时改了行为 | 重构只改结构，不改逻辑 |

## 关联 Skill

- [debugging](../debugging/SKILL.md) — 测试失败后的调试
- [code-search](../code-search/SKILL.md) — 搜索代码和测试结构
