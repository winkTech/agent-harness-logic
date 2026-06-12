# 记忆索引

> 完整记忆文件见各子目录。类型/生命周期见 [MEMORY_RULES.md](MEMORY_RULES.md)。

## 经验 (learnings/)

| 文件 | 内容 |
|:-----|:-----|
| [[lessons-summary]] | 最佳实践汇总 |
| [[pipeline-framework-must-follow-order]] | 工作流纪律 |
| [[context-compression-rule]] | 压缩策略 |
| [[knowledge-retrieval-priority]] | 检索顺序 |
| [[agent-evaluation-v7]] | 评分 6.0→9.5 |
| [[ldpc-rtl-review-lessons]] | 编码审查 |
| [[2026-06-03-daily-summary]] | 日总结 |
| [[agent-health-audit]] | 定期审查 |
| [[memory-accumulation-plan]] | 积累策略 |
| [[uvm-verification-framework]] | UVM 踩坑 |
| [[uvm-framework-architecture]] | 通用模板选择 |
| [[knowledge-map-compliance]] | 三同步原则 |
| [[software-install-rule]] | 默认 D 盘，禁止 C 盘 |
| [[desensitization-rule]] | 所有 git 追踪文件必须脱敏 |
| [[memory-auto-trigger]] | PostMessage/SessionStart/Cron 三层触发 |
| [[doc-bloat-anti-pattern]] | 知识文档不应包含完整代码/模板 — 引用 docs/templates/ 即可 |
| [[hdl-golden-model-philosophy]] | Golden Model 绝对权威 + RTL↔MATLAB 严格对标原则 |
| [[file-organization-discipline]] | 文件分类纪律 — 仿真/测试/文档必须归入对应目录 |
| [[agent-context-budget-integration]] | Agent 上下文预算系统集成 — 宪法段保护 |

## 当前进度

> 当前任务态参见 `var/active-task.yaml` — 每次 session 开始时自动读取，结束时 `/handoff` 更新。
> 工作记忆文件 (`var/work/*.md`) 是 session 级记录，不进长期语义索引。

## 错误 (errors/)

| 文件 | 内容 |
|:-----|:-----|
| [[GateGuard 触发问题]] | 钩子拦截 |
| [[pdf-extraction-limitation]] | 分段读取 |
| [[open-source-dir-loss]] | 恢复操作 |

## 项目 (projects/)

[[agent-optimization-roadmap]] — Agent 长期优化路线图（3 阶段）

## 参考链接

[[cross-project-experience-ref]] — 新 FPGA 项目启动模板

## 模板

| 文件 | 用途 |
|:-----|:-----|
| [TEMPLATE](work/TEMPLATE.md) | 工作记忆模板 |
| [ERROR_TEMPLATE](errors/ERROR_TEMPLATE.md) | 错误记录模板 |
