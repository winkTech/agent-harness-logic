# 🧠 全局记忆索引

> 跨项目共享的工作记忆、错误经验、学习教训

---

## 记忆类型

| 类型 | 说明 | 文件位置 |
|------|------|----------|
| `work` | 工作状态、决策记录 | `work/` |
| `error` | 错误经验、教训 | `errors/` |
| `learning` | 学习总结、最佳实践 | `learnings/` |
| `project` | 项目专属规划与追踪 | `projects/` |

---

## 规则文档

- [记忆触发规则](MEMORY_RULES.md) — 何时、如何记录记忆

---

## 索引列表

### 模板

- [工作记忆模板](work/TEMPLATE.md) — 记录工作状态、决策、进度
- [错误经验模板](errors/ERROR_TEMPLATE.md) — 记录错误、原因、解决方案

### 经验库

- [经验教训汇总](learnings/LESSONS.md) — 从错误中提炼的最佳实践
- [流水线框架必须严格执行](learnings/2026-06-02-流水线框架必须严格执行.md) — 框架设计者必须第一个遵守
- [上下文压缩规则](learnings/2026-06-02-上下文压缩规则.md) — Agent上下文超过40%必须/compact
- [知识检索优先级规则](learnings/2026-06-02-知识检索优先级规则.md) — 优先使用 rag-skill 知识库检索
- [Agent 自评报告 v2](learnings/2026-06-03-agent-evaluation.md) — Phase1 后全面盘点：52 文档/37 模型/19 RTL/7维度评分（6.6/10）
- [LDPC RTL 审查经验](learnings/2026-06-03-ldpc-rtl-review-lessons.md) — 3 类 Bug + RTL 可靠性 Checklist
- [今日复盘 0603](learnings/2026-06-03-daily-summary.md) — 成功决策/修正失误/告诫未来
- [Agent 健康审查规范](learnings/2026-06-04-agent-health-audit.md) — 七维审查清单 + 脚本：断裂链接/孤立文件/记忆引用/配置一致性

### 工作记忆

- [Phase 1 完成](work/2026-06-03-phase1-complete.md) — LTE/NR 知识库 8 篇 + Python 调试 Skill 6 模板 ✅
- [记忆系统搭建](work/2026-06-01-记忆系统搭建.md) — 建立全局记忆系统，支持工作记忆和错误经验学习
- [新插件适配](work/2026-06-01-新插件适配.md) — 适配 coding-tutor 和 compound-engineering 插件
- [Agent优化](work/2026-06-02-Agent优化.md) — CLAUDE.md 模块化重构 300→97行
- [知识库构建](work/2026-06-02-知识库构建.md) — FPGA/通信知识库搭建（24文档+35PDF）
- [记忆系统优化](work/2026-06-02-记忆系统优化.md) — 记忆自动记录+智能检索功能
- [开源评估结果](work/2026-06-02-开源评估.md) — 开源项目完整性评估，识别6类缺失

### 错误记录

- [GateGuard 触发问题](errors/2026-06-01-GateGuard触发问题.md) — 系统安全机制拦截文件操作，需要声明事实才能继续
- [PDF提取限制](errors/2026-06-02-PDF提取限制.md) — markitdown 对部分 PDF 编码格式不支持
- [开源目录丢失](errors/2026-06-02-开源目录丢失.md) — 相对路径导致目录创建在错误位置

---

## 快速检索

- 按日期: 查看文件名中的时间戳
- 按类型: 浏览对应目录
- 按关键词: 搜索文件内容

---

*上次更新: 2026-06-04*

### 项目规划

- [Agent 长期优化路线图](projects/2026-06-03-agent-optimization-roadmap.md) — 3阶段6任务优化计划（✅ Phase 1 完成: LTE/NR知识库 + Python调试Skill）
