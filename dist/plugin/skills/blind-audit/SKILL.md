---
name: blind-audit
description: 当用户要求“独立审计”“盲审”“blind audit”“先写预期再看测试结果”或对升级/模块做四象限对抗验收时使用。先用 blind-audit-seal.cjs 加封预期，再在隔离目录实跑坏输入、过期产物、中断恢复与好输入零误伤四象限探针，严格区分实跑、历史、推断与未验证项。
---

# 双盲独立审计 (Blind Audit)

## 核心铁律

1. **先锁预期，后看测试**：阅读 `test-hooks/`、`*.test.*` 或实现者自测报告前，必须先根据规格、文档与产品入口写下四象限可证伪预期，并执行 `node core/engine/scripts/blind-audit-seal.cjs seal --expectation <auditDir>/01-blind-expectations.md --seal-out <auditDir>/seal.json` 锁定 SHA-256 印章。
2. **产品只读，隔离复现**：被审仓库与真实工程保持只读，全部故障注入、杀进程与编译仿真均在系统临时目录的隔离目录中完成。
3. **四象限必测**：
   - `bad_input_rejected`：坏结果、时序违例或伪造绿状态是否被可靠拒收；
   - `stale_artifact_rejected`：修改源码或传递依赖后旧报告/旧缓存是否失效拒收；
   - `interrupted_job_recovered`：强杀守护进程、取消或超时后能否按文档恢复且不丢已验回执；
   - `valid_input_accepted`：真实合规结果是否端到端放行，结构化摘要是否因丢字段而误拒。
4. **证据四分级**：所有结论显式标明 `本次实跑`、`已核验历史记录`、`静态推断` 或 `未验证项`，给出样本量与适用边界。
5. **工作流编排**：支持工作流执行器的宿主可直接调用 `Workflow({name: 'blind-audit-workflow', args: {targets: [...]}})`。
