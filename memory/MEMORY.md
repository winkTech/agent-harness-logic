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
| [[memory-accumulation-plan]] | 已废弃：不再以文件数量作为记忆质量指标 |
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
| [[instruction-compliance]] | 已退役：正常动作由账本记录，仅偏差/阻断/扩权时报告；由 AGENTS.md:16 替代 |
| [[agent-workflow-refinement]] | Agent+Workflow 优化 — 架构拆解缺失/验证归属/不透明 三项修复 |
| [[project-directory-cleanup-discipline]] | 项目目录标准化 + 仿真 transient 清理纪律 |
| [[fix-in-place-discipline]] | Fix-in-Place 纪律 — 禁止文件变体，agent 必须原地修改 |
| [[sim-governance]] | 仿真治理 — 自动清理 wlft*/transcript, 生成 JSON 证据 |
| [[per-module-pipeline]] | Phase 4 分拆 — 每模块独立 agent, 35 模块不溢出 |
| [[2026-06-23-self-learning-boot]] | 自学习系统启动：CHECK 修复 + Dream 激活 + Skill-Evolve 验证
| [[verification-must-be-functional]] | ⚠️ 验证必须是功能验证，不只是语法检查 — lint 不清除门禁标记 |
| [[requirements-gate-wifi-evidence]] | 🔍 需求澄清门禁设计依据 — WiFi PHY 10条泛化教训 + MD Spec Only 场景预防 |
| [[verification-quality-wifi-evidence]] | 🧪 验证质量门禁设计依据 — 环境失真 8 条教训 → 环境画像+最少场景集+增量集成 |
| [[knowledge-base-search-mandate]] | 📚 知识库强制检索 — 规则写了但不遵守的根因 + 设计前必搜 knowledge/ 示例代码 |

## 当前进度

> 当前任务态参见 `var/active-task.yaml` — 每次 session 开始时自动读取，结束时 `/handoff` 更新。
> 工作记忆文件 (`var/work/*.md`) 是 session 级记录，不进长期语义索引。

## 错误 (errors/)

| 文件 | 内容 |
|:-----|:-----|
| [[GateGuard 触发问题]] | 钩子拦截 |
| [[pdf-extraction-limitation]] | 分段读取 |
| [[open-source-dir-loss]] | 恢复操作 |
| [[file-variant-explosion]] | Agent 文件变体爆炸 — 21 版本/8 TB/61 wlft — WiFi PHY 项目 |

## 项目 (projects/)

[[agent-optimization-roadmap]] — Agent 长期优化路线图（3 阶段）
[[fullframe-tb-frame-boundary-bug]] — 全帧TB: rx_fifo反压修复完成, viterbi双traceback已修复, 帧边界2562正确
[[viterbi-double-traceback-fix]] — viterbi DONE→IDLE跨block NBA竞态, r_tb_pending_clear门控修复
[[skill-evolve-harness]] — SkillOpt 蒸馏到本地 harness: session模式挖掘+held-out门禁+PostStop自动stage
[[self-learning-system]] — 自学习系统启动报告: 2026-06-23 激活 Dream + Skill-Evolve + 信号采集 pipeline
[[2026-07-17-wifi-phy-agent-run-experience]] — WiFi PHY 多 Agent 工作树、路径、门禁与仿真运行经验

## 参考链接

[[cross-project-experience-ref]] — 新 FPGA 项目启动模板
[[memory-link-graph]] — 记忆关联图

## 反馈 (feedback/)

- [No Direct Push Main](feedback_no_direct_push_main.md) — 禁止直接推送 main 分支，必须走 PR 流程

## Agent 定义 (agents/)

| 文件 | 角色 |
|:-----|:------|
| [[algorithm-engineer]] | agents/domain/ — 算法建模/定点/向量生成/Golden Model |
| [[logic-engineer]] | agents/domain/ — RTL 编码/TB/仿真/顶层集成/综合 |
| [[algorithm-engineer-agent]] | memory/agents/ — 算法工程师 Agent 创建记录 |
| [[logic-engineer-agent]] | memory/agents/ — 逻辑工程师 Agent 创建记录 |

## 知识库方法论 (knowledge/methodology/)

| 文件 | 适用 | 内容 |
|:-----|:-----|:------|
| [[fixed-point-methodology]] | 算法工程师 | 定点量化全流程、位宽确定、截断策略 |
| [[test-vector-generation]] | 算法+逻辑工程师 | 测试向量格式、corner case、自检脚本模板 |
| [[golden-model-standards]] | 算法工程师 | Golden Model 编码规范、分段对标、版本管理 |
| [[matlab-mcp-guide]] | 算法工程师 | MATLAB MCP 高效使用技巧 |
| [[conv-coding-algorithm-spec]] | 算法工程师 | 卷积编码+Viterbi译码 算法全规范 (K=7/速率1-2/软硬判决/定点/向量) |

## 知识库参考 (knowledge/references/)

| 文件 | 适用 | 内容 |
|:-----|:-----|:------|
| [[sva-patterns]] | 逻辑工程师 | SVA 断言模板（握手/FIFO/FSM/流水线） |
| [[eda-debug-checklist]] | 逻辑工程师 | EDA 调试决策树（lint/仿真/Vivado/Questa） |

## 模板

| 文件 | 用途 |
|:-----|:-----|
| [TEMPLATE](work/TEMPLATE.md) | 工作记忆模板 |
| [ERROR_TEMPLATE](errors/ERROR_TEMPLATE.md) | 错误记录模板 |
| [Makefile.sim](knowledge/docs/templates/makefile-templates/Makefile.sim) | 仿真自动化模板 |
| [Makefile.vivado](knowledge/docs/templates/makefile-templates/Makefile.vivado) | Vivado 综合模板 |
