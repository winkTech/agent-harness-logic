---
name: per-module-pipeline
description: "Phase 4 分拆 — 每个 RTL 模块用独立 agent, 避免 35 模块塞一个 context 溢出"
metadata:
  type: learning
---

# Per-Module Pipeline

**核心**：Phase 4 RTL 编码时，每个模块使用独立 agent，不共享 context。

## 背景

原工作流 Phase 4 用一个 agent 处理所有模块。当项目有 35 个模块（TX 18 + RX 17）时：
- 单个 context 要容纳所有接口定义、定点格式、FSM 状态 → **必然溢出**
- 溢出后 agent 质量断崖下跌 → 产生文件变体、接口不一致、逻辑错误
- 证据：项目中出现 21 个 freq_recovery 版本、8 个 TB 版本

## 解决方案

工作流 `hdl-coding-dag-workflow.js` Phase 4 改为 `pipeline()` 结构：

```
每个模块独立 agent:
  agent("编码 scrambler", {label: "rtl-scrambler"})
  agent("编码 fec_encoder", {label: "rtl-fec_encoder"})  
  agent("编码 interleaver", {label: "rtl-interleaver"})
  ... 每个模块独立 context, 互不干扰
```

## 关键设计

- 使用 Workflow 引擎的 `pipeline()` 函数，不是 `parallel()` — 逐个完成，避免 35 路并行
- 每个 agent 只接收自己模块的架构信息（`architecture.yaml` 中对应条目）
- 每模块完成后输出 JSON 证据 → Phase 4.5 统一门禁检查
- 模块间依赖由 `architecture.yaml` 定义，不依赖 agent 间通信

## 应用

- 任何模块数 > 5 的项目必须使用 per-module pipeline
- 配合 [[fix-in-place-discipline]] 和 [[evidence-gate]] 使用

**Why**: 单个 context 放 35 个模块 = 必然溢出 = 质量崩溃。
**How to apply**: 使用 `hdl-coding-dag-workflow` 传入 modules 参数，工作流自动分拆。
