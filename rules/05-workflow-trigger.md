---
name: workflow-trigger-rules
description: "工作流调用规则 — 关键词触发 + 安全敏感绑定 + 不可跳越红线"
priority: L3
---

# 工作流调用规则

> L3 优先级：命中关键词时才加载。定义各工作流的触发条件，确保流程不被跳过。

## 关键词 → 工作流映射

| 用户表述 | 触发的工作流 | 说明 |
|:---------|:------------|:------|
| 新模块/写RTL/写TB/算法实现/定点 | `hdl-coding-workflow` | 必须从 Phase 0 或 1 开始，不可跳过架构设计 |
| 审查代码/代码质量/PR审查 | `code-review-workflow` | 先 Pass 1 再 Pass 2 |
| 架构审查/代码库评估/技术债 | `architecture-review-workflow` | 多 Agent 并行审查 |
| 安全审查/认证/密钥/支付/文件上传 | `security-review-workflow` | 独立安全审查流程 |
| HDL 编码时问知识/查参考 | rag-skill（自动 Hook） | 系统侧拦截，无感执行 |

## Phase 完成自动触发

```
hdl-coding Phase 6（代码审查）完成
    → 自动加载 code-review-workflow 执行审查
    → code-review Pass 1 中发现架构问题
        → 自动升级到 architecture-review-workflow
    → code-review 涉及安全敏感变更
        → 自动加载 security-review-workflow 补充审查
```

## 安全敏感关键词自动绑定

遇到以下关键词时，**必须同时加载 security-review-workflow**：
- `auth` / `token` / `password` / `secret` / `api_key` / `credential`
- `payment` / `checkout` / `refund` / `wallet`
- `upload` / `file upload` / `attachment`
- `encrypt` / `decrypt` / `cipher` / `TLS` / `HTTPS`
- `SQL` / `injection` / `XSS` / `CSRF`

## 不可跳越红线

- 写 RTL 前必须先过 Phase 1（架构框图）和 Phase 2（定点量化）——不允许直接写代码
- Phase 6 未完成（code-review 未通过）不允许提交
- code-review Pass 1 有阻塞项不允许进入 Pass 2
- 代码库 > 10K LOC 但未做架构审查 → 标记为流程违规
