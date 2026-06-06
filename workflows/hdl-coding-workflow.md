---
name: hdl-coding-workflow
description: RTL 开发全流程 — 规格→编码→Lint→仿真→审查
version: 1.0.0
agents: [developer, qa, code-reviewer]
phases: 4
complexity: medium
triggers:
  - new RTL module
  - testbench creation
  - lint cleanup
  - code review prep
---

# HDL Coding Workflow

RTL 开发的标准操作流程，覆盖从规格到审查的完整链路。

---

## Phase 1: 规格与架构

**输入**: 需求描述 / 接口定义

1. **接口确定** — 模块端口列表（时钟/复位/数据/控制）
2. **时序规划** — 流水线级数、时钟域、握手协议
3. **状态机设计** — 状态转移图（Mealy/Moore）
4. **量化分析** — 位宽、资源估算、时序余量目标

**输出**: 接口规格 + 状态图

---

## Phase 2: RTL 编码

**输入**: 接口规格

1. **模块模板** — 按 `skills/hdl-coding/` 的命名规范创建文件
2. **时序逻辑** — 所有寄存器用 `always_ff`，组合逻辑用 `always_comb`
3. **状态机** — 三段式（状态声明→次态→输出）
4. **参数化** — 用 `parameter` / `localparam` 做可配置设计
5. **注释** — 每个 always 块说明用途

**输出**: RTL 源码（.sv / .v）

---

## Phase 3: Lint + 仿真验证

**输入**: RTL 源码

1. **Lint 检查** — `vlog -lint <file>`，清零所有 warning
2. **模块级仿真** — 编写自检 Testbench + 波形 dump
3. **功能覆盖** — 正常/边界/错误输入三个方向

**输出**: Lint 通过报告 + 仿真波形

---

## Phase 4: 代码审查准备

**输入**: 源码 + 仿真结果

1. **自审查清单**:
   - [ ] 无组合环路
   - [ ] 多驱动检查
   - [ ] CDC 同步器（两级 reg / 握手 / FIFO）
   - [ ] 复位极性一致性
   - [ ] 无 lint warning
2. **提交 code-review** — 用 `code-review` 的 quality 模式

**输出**: 审查通过的 RTL

---

## 关联资源

- [HDL 编码规范](../skills/hdl-coding/SKILL.md) — 详细命名规则和 lint 门禁
- [TDD Workflow](../skills/tdd/SKILL.md) — Testbench 先行开发
- [Code Review](../workflows/code-review-workflow.md) — 审查环节
