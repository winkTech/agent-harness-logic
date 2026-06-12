---
name: workflow-trigger-rules
description: "工作流调用规则 — 关键词触发 + 安全敏感绑定 + 不可跳越红线"
priority: L3
trigger: "用户表述含关键词时加载（见下方表格）"
skip: "纯执行无需工作流"
---

# 工作流调用规则

> L3 优先级：命中关键词时才加载。定义各工作流的触发条件，确保流程不被跳过。

## 关键词 → 工作流映射

| 用户表述 | 触发的工作流 | 执行方式 | 说明 |
|:---------|:------------|:---------|:------|
| 新模块/写RTL/写TB/算法实现/定点 | `hdl-coding-workflow` | `Workflow({name: 'hdl-coding-workflow', args})` | 多 Agent 并行流水线，必须从 Phase 0 开始 |
| 审查代码/代码质量/PR审查 | `code-review-workflow` | `Workflow({name: 'code-review-workflow', args})` | Adversarial 审查：Writer→Reviewer→Arbiter |
| 架构审查/代码库评估/技术债 | `architecture-review-workflow` | `Workflow({name: 'architecture-review-workflow', args})` | 四维并行：性能/资源/时序/接口 |
| 安全审查/认证/密钥/支付/文件上传 | `security-review-workflow` | 调用 `/security-review` skill | 独立安全审查流程 |
| HDL 编码时问知识/查参考 | rag-skill（自动 Hook） | 系统侧拦截，无感执行 | — |
| 小改动/快速修复/改位宽/加pipeline/精简流程(小修改) | `hdl-coding-workflow (Lite)` | `Workflow({name: 'hdl-coding-dag-workflow', args: {modules, lite: true}})` | ⚡ Lite 模式: 跳过 P2+P6, 适用不影响算法/时序的小修改

## 已保存的工作流脚本

工作流脚本位于 `skills/workflows/`（JS DAG 流）或 `skills/workflows/<名称>/`（MD 阶段流）：

| 文件名 | 入口 | args 格式 |
|:-------|:-----|:----------|
| `hdl-coding-workflow.js` | `Workflow({name: 'hdl-coding-workflow', args: {modules, projectRoot?}})` | `{modules: string[], projectRoot?: string}` |
| `hdl-coding-dag-workflow.js` | `Workflow({scriptPath: 'skills/workflows/hdl-coding-dag-workflow.js', args: {modules}})` | `{modules: string[], securityModules?: string[], standardModules?: string[], projectRoot?: string, lite?: boolean}` ⚡ DAG v3.4 证据驱动: 逐模块脚本化对比 → 证据门禁 → 全链仿真, 含 Verifier + 对抗验证 |
| `code-review-workflow.js` | `Workflow({name: 'code-review-workflow', args: {files, projectRoot?}})` | `{files: string[], projectRoot?: string}` |
| `architecture-review-workflow.js` | `Workflow({name: 'architecture-review-workflow', args: {targets, projectRoot?}})` | `{targets: string[], projectRoot?: string}` |

### 调用示例

```
// 并行实现 scrambler + descrambler
Workflow({name: 'hdl-coding-workflow', args: {
  modules: ['scrambler', 'descrambler'],
  projectRoot: 'd:/Project_Files/ofdm/wifi_example/prj'
}})

// 混合模式: 均衡器高安全, 其他标准 (自动分类 + 手动覆盖)
Workflow({name: 'hdl-coding-dag-workflow', args: {
  modules: ['scrambler', 'viterbi', 'descrambler'],
  securityModules: ['viterbi'],            // viterbi → 高安全模式
  standardModules: ['scrambler'],          // 强制标准 (即使含匹配关键词)
}})

// 审查最近修改的文件
Workflow({name: 'code-review-workflow', args: {
  files: ['01_src/tx/scrambler.sv', '01_src/rx/descrambler.sv']
}})

// 架构审查顶层模块
Workflow({name: 'architecture-review-workflow', args: {
  targets: ['01_src/tx/ofdm_tx.sv', '01_src/rx/ofdm_rx.sv']
}})

// Lite 模式 (小改动 — 跳过定点扫描和覆盖率回归, Phase 4.5 文件门禁保留)
Workflow({name: 'hdl-coding-dag-workflow', args: {
  modules: ['fir_filter'],
  lite: true
}})

// Lite + 手动指定高安全模块 (对抗验证对修改也执行)
Workflow({name: 'hdl-coding-dag-workflow', args: {
  modules: ['equalizer'],
  lite: true,
  securityModules: ['equalizer'],          // Lite 下对抗 agent 仍运行
}})
```

### Lite 模式适用条件

| 允许 | 不允许 |
|:-----|:--------|
| 位宽调整 (不改算法逻辑) | 新功能/新算法模块 |
| Pipeline 级数调整 | 影响时序路径 |
| 接口信号重命名 | 新增接口/协议变更 |
| 注释/文档更新 | 影响定点 bit-true 一致性 |
| 已有模块的 bugfix | 顶层架构变更 |

## Phase 完成自动触发

```
hdl-coding Phase 7（代码审查）完成
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
- **Phase 4.5 (证据门禁) 未通过不允许进入 Phase 5 (顶层集成)** — 机制上已强制（DAG 依赖链锁定）
- Phase 7 未完成（code-review 未通过）不允许提交
- code-review Pass 1 有阻塞项不允许进入 Pass 2
- 代码库 > 10K LOC 但未做架构审查 → 标记为流程违规
