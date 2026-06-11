---
name: advanced-features
description: 高级功能参考
metadata:
  type: reference
---

# 高级功能参考

> Skill 调用优先级、工作流模板、Agent/Hook 边界

---

## Skill 调用优先级

| 优先级 | 场景 | 首选 | 备选 |
|--------|------|------|------|
| 1 | 读取PDF | rag-skill | markitdown-converter |
| 2 | PPT/Word/Excel | markitdown-converter | — |
| 3 | 精确搜索 | ripgrep | code-semantic-search |
| 4 | 语义搜索 | code-semantic-search | ripgrep |
| 5 | 简单调试 | debugging | smart-debug |
| 6 | 复杂调试 | smart-debug | debugging |
| 7 | RTL编码 | hdl-coding | — |
| 8 | RTL测试 | tdd + test-generator | — |

---

## 工作流模板

**A. PDF→RTL**: rag-skill → markitdown-converter → deep-research → brainstorming → code-review(architecture模式) → tdd → hdl-coding → doc-generator

**B. 文档分析**: markitdown-converter → rag-skill → code-semantic-search → code-review(architecture模式)

---

## Agent 边界

| Agent | 功能 | 调用条件 |
|-------|------|----------|
| router | 路由分发 | 自动运行 |
| planner | 任务规划 | 3+步骤任务 |
| developer | 代码实现 | 编写代码（最后手段） |
| qa | 测试执行 | 验证Testbench |
| architect | 架构设计 | 模块划分、接口设计 |
| code-reviewer | 代码审查 | 代码写完后自动触发 |
| researcher | 技术调研 | 调研算法方案 |
| advanced-debugging | 复杂调试 | 常规调试无法定位 |

---

## Hook 边界

**安全类**（自动运行）: router-tool-lockdown(防越权)、external-content-guard(拦截注入)、dlp-pretool(数据防护)

**质量类**: pre-completion-validation(完成验证)、post-pipeline-self-review(自动审查)
