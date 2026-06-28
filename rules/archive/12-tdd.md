---
name: tdd-rules
description: "TDD 测试驱动开发规则 — RED/GREEN/REFACTOR 循环、测试规范"
priority: L2
trigger: "测试驱动 / 先写测试 / 写测试 / TDD / 单元测试 / 测试用例 / 测试覆盖 / 测试优先"
skip: "纯文档修改 / 注释修改 / 代码审查 / 架构设计 / RTL 编写 / 绘图"
---

# TDD 测试驱动开发规则

> L2 优先级：涉及测试/TDD 工作时自动加载。

## 铁律

1. **未证明 RED 之前不写实现代码** — 没有 RED 阶段的 GREEN 是假 GREEN
2. **最小 GREEN 补丁** — 只够让当前失败测试通过，不多写一行
3. **一次一个 scenario** — 完成一个 scenario 的 RED→GREEN→REFACTOR 全循环后，再进入下一个
4. **测试不加 try/catch，不 hack 断言（`ok(true)`）** — 测试必须能真实验证代码行为
5. **重构阶段只改结构不改行为** — 重构后所有测试必须仍为 GREEN

## Canon Loop

```
1. 写一个失败测试（RED）
   ↓
2. 写最小代码让测试通过（GREEN）
   ↓
3. 重构代码和测试（REFACTOR）
   ↓
4. 循环到所有 scenario 覆盖
```

## 测试规范

- 测试文件命名：`test_<模块名>.py` 或 `<模块名>_test.sv`
- 每个测试一个断言原则（一个测试函数只验证一个行为）
- Mock 外部依赖，不测实现细节
- 测试覆盖率目标：核心逻辑 ≥ 90%，整体 ≥ 70%

## 详细参考

- 完整 TDD Skill：`skills/tdd/SKILL.md`
- 方法参考：`skills/tdd/references/tdd-memory-profile.md`
- 变异测试：`skills/tdd/references/mutation-testing.md`
- 契约测试：`skills/tdd/references/contract-testing.md`
