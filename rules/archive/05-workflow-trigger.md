---
name: workflow-trigger-rules
description: "工作流调用规则 — 关键词触发 + 安全敏感绑定 + 不可跳越红线"
priority: L3
trigger: "用户表述含关键词时加载（见下方表格）"
skip: "纯执行无需工作流"
---

# 工作流调用规则

> L3 优先级：命中关键词时才加载。

## 关键词 → 工作流映射

| 用户表述 | 触发的工作流 | 说明 |
|:---------|:------------|:------|
| 新模块/写RTL/写TB/算法实现/定点 | `hdl-coding-dag-workflow` | 多 Agent 并行流水线，必须从 Phase 0 开始 |
| hdl编码/写RTL(别名) | `hdl-coding-workflow` | 与 `hdl-coding-dag-workflow` 等价 |
| hdl编码/快速修复(别名) | `hdl-coding-workflow` | 与 `hdl-coding-dag-workflow` 等价，Lite模式兼容 |
| 审查代码/代码质量/PR审查 | `code-review-workflow` | Pass 1 正确性阻塞 → Pass 2 质量建议 → HDL 专项证据审查 |
| 架构审查/代码库评估/技术债 | `architecture-review-workflow` | 上下文收集 → 架构/安全并行分析 → 证据化建议 |
| 安全审查/认证/密钥/支付 | `security-review-workflow` | 威胁建模 → `workflow-evidence-scan.cjs` 确定性扫描 → 手动验证 → 修复计划 |
| HDL 编码时问知识/查参考 | rag-skill（自动 Hook） | 系统侧拦截，无感执行 |
| 小改动/快速修复/改位宽 | `hdl-coding-dag-workflow` (Lite) | 跳过 P2+P6 |
| 用户指定了实现方向 | 退出分析 → `hdl-coding-dag-workflow` | 区分"调试"和"实现" |

## 调用语法

```js
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['scrambler']}})         // HDL 全流程 (主入口)
Workflow({name: 'hdl-coding-workflow', args: {modules: ['scrambler']}})              // 别名，同上
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['viterbi'], lite: true}}) // Lite 模式
Workflow({name: 'code-review-workflow', args: {files: ['01_src/tx/scrambler.sv']}})
Workflow({name: 'architecture-review-workflow', args: {targets: ['01_src/tx/ofdm_tx.sv']}})
Workflow({name: 'security-review-workflow', args: {targets: ['src/']}})
```

### Lite 模式适用条件

| 允许 | 不允许 |
|:-----|:--------|
| 位宽调整、Pipeline 级数调整 | 新功能/新算法模块 |
| 接口信号重命名、注释更新 | 影响时序/定点一致性 |

## 安全敏感关键词

遇到以下关键词时，**必须同时加载 security-review-workflow**：
- `auth` / `token` / `password` / `secret` / `credential`
- `payment` / `checkout` / `encrypt` / `decrypt`
- `SQL` / `injection` / `XSS` / `CSRF`

## 不可跳越红线

- 写 RTL 前必须先过 Phase 1（架构）和 Phase 2（定点）——不允许直接写代码
- **Phase 1 必须包含微架构拆解**（流水线/FSM/位宽映射）— 无架构方案不写 RTL
- Phase 4.5 (证据门禁) 未通过不允许进入 Phase 5 (顶层集成)
- **Phase 5 最终输出必须与定点 Golden Model bit-true 对齐**（不允许用容差掩盖算法偏离）
- Phase 7 未完成（code-review 未通过）不允许提交
- 用户指定了实现方向 → 必须实施，不得继续分析

## 验证归属

- **所有的 RTL 验证/TB/调试/对比脚本**归逻辑工程师，调度层不做
- 调度层负责：组织流程、呈报 artifact、协调算法↔逻辑工程师争议
- 检查点 Phase 1/2/3/4.5/5/7 产出 artifact 后暂停，用户审查确认后再继续
