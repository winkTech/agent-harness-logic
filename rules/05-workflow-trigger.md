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
| 新模块/写RTL/写TB/算法实现/定点 | `hdl-coding-workflow` | 多 Agent 并行流水线，必须从 Phase 0 开始 |
| 审查代码/代码质量/PR审查 | `code-review-workflow` | Adversarial 审查：Writer→Reviewer→Arbiter |
| 架构审查/代码库评估/技术债 | `architecture-review-workflow` | 四维并行：性能/资源/时序/接口 |
| 安全审查/认证/密钥/支付 | `security-review-workflow` | 调用 `/security-review` skill |
| HDL 编码时问知识/查参考 | rag-skill（自动 Hook） | 系统侧拦截，无感执行 |
| 小改动/快速修复/改位宽 | `hdl-coding-dag-workflow` (Lite) | 跳过 P2+P6 |
| 用户指定了实现方向 | 退出分析 → `hdl-coding-workflow` | 区分"调试"和"实现" |

## 调用语法

```js
Workflow({name: 'hdl-coding-workflow', args: {modules: ['scrambler']}})
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['viterbi'], lite: true}})
Workflow({name: 'code-review-workflow', args: {files: ['01_src/tx/scrambler.sv']}})
Workflow({name: 'architecture-review-workflow', args: {targets: ['01_src/tx/ofdm_tx.sv']}})
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
- Phase 4.5 (证据门禁) 未通过不允许进入 Phase 5 (顶层集成)
- Phase 7 未完成（code-review 未通过）不允许提交
- 用户指定了实现方向 → 必须实施，不得继续分析
