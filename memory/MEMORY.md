# 🧠 记忆索引

> 管理所有工作记忆、错误经验、学习教训

---

## 记忆类型

| 类型 | 说明 | 文件位置 | 寿命 |
|------|------|----------|:----:|
| `work` | 工作状态、决策记录 | `work/` | 14天 → archive |
| `error` | 错误经验、教训 | `errors/` | 90天 → archive |
| `learning` | 学习总结、最佳实践 | `learnings/` | 永久 |
| `project` | 项目专属规划与追踪 | `projects/` | 项目完成+30天 |
| `archive` | 已归档的历史记录 | `archive/` | 永久保留 |

---

## 规则文档

- [记忆触发规则](MEMORY_RULES.md) — 何时、如何记录记忆
- [记忆生命周期](MEMORY_RULES.md#五记忆生命周期) — 过期判定、清理方法

---

## 索引列表

### 模板

- [工作记忆模板](work/TEMPLATE.md) — 记录工作状态、决策、进度
- [错误经验模板](errors/ERROR_TEMPLATE.md) — 记录错误、原因、解决方案

### 经验库

- [经验教训汇总](learnings/LESSONS.md) — 从错误中提炼的最佳实践
- [流水线框架必须严格执行](learnings/2026-06-02-流水线框架必须严格执行.md)
- [上下文压缩规则](learnings/2026-06-02-上下文压缩规则.md)
- [知识检索优先级规则](learnings/2026-06-02-知识检索优先级规则.md)
- [Agent 自评报告 v2](learnings/2026-06-03-agent-evaluation.md)
- [LDPC RTL 审查经验](learnings/2026-06-03-ldpc-rtl-review-lessons.md)
- [今日复盘 0603](learnings/2026-06-03-daily-summary.md)
- [Agent 健康审查规范](learnings/2026-06-04-agent-health-audit.md)
- [记忆积累计划](learnings/MEMORY_ACCUMULATION_PLAN.md)
- [UVM 验证框架（OFDM TX 实战）](learnings/2026-06-04-UVM-验证流程与方法.md) — UVM 组件架构、四要素、FPGA 验证裁剪与 6 个踩坑记录
- [UVM 框架架构决策](learnings/2026-06-05-uvm-framework-architecture.md) — 通用模板 + factory override + 统一 32-bit 接口 (4 算法覆盖)
- [JESD204B 高速接口指南](../knowledge/primary/domains/fpga/jesd204b-guide.md) — P1 交付物: 协议/参数计算/调试/PCB/RFSoC
- [MATLAB↔Python 协同仿真](skills/python-hardware-debug/templates/matlab_cosim.py) — P1 交付物: 双引擎模式 + 4 算法支持 + 对比报告
- [Tcl 自动构建指南](../knowledge/primary/domains/fpga/vivado-automation-guide.md) — P2 交付物: 脚本模板/策略对比/非工程模式/CI 集成
- [时序收敛实战案例](../knowledge/primary/domains/fpga/timing-convergence-cases.md) — P2 交付物: 7 个真实收敛案例 (IFFT/复位扇出/CDC/GTY/BRAM)
- [PCIe 高速接口指南](../knowledge/primary/domains/fpga/pcie-guide.md) — P3 交付物: TLP/DMA/AXI/参考工程
- [Aurora 高速接口指南](../knowledge/primary/domains/fpga/aurora-guide.md) — P3 交付物: 8B/10B+64B/66B/天线阵列
- [SelectMap 配置指南](../knowledge/primary/domains/fpga/selectmap-guide.md) — P3 交付物: 并行配置/多 Boot/RFSoC
- [ORAN/eCPRI 分析工具](skills/python-hardware-debug/templates/oran_analysis.py) — P3 交付物: 前传接口分析 (8 模板)
- [LDPC UVM 验证框架](knowledge/primary/domains/comm/ldpc/uvm_tb/) — P3 交付物: 6 文件 UVM (5 算法全覆盖)

### 参考链接

- [跨项目经验复用](references/cross-project-experience-link.md) — 新 FPGA 项目启动时参考的模板结构

### 工作记忆

- [Agent 基座加固计划](work/2026-06-04-agent-base-reinforcement-plan.md) — 技能瘦身/配置修复/安全加固，明日执行
- [Agent 基座健康评分](work/2026-06-04-agent-health-score.md) — 66→93/100 (C+→A)，6维度全面修复
- [Phase 1 完成](work/2026-06-03-phase1-complete.md) — LTE/NR 知识库 8 篇 + Python 调试 Skill 6 模板 ✓
- [Phase 3 完成](work/2026-06-05-phase3-complete.md) — 6 项交付物，评分 8.5/10 (+0.5)

### 错误记录

- [GateGuard 触发问题](errors/2026-06-01-GateGuard触发问题.md)
- [PDF提取限制](errors/2026-06-02-PDF提取限制.md)
- [开源目录丢失](errors/2026-06-02-开源目录丢失.md)

### 项目规划

- [Agent 长期优化路线图](projects/2026-06-03-agent-optimization-roadmap.md)

### 已归档

- [工作记录归档](archive/) — 已完成的任务记录（7 项）
- 需要时浏览 `memory/archive/` 目录

---

## 快速检索

- 按日期: 查看文件名中的时间戳
- 按类型: 浏览对应目录
- 按关键词: 搜索文件内容

---

*上次更新: 2026-06-05*
