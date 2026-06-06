---
name: architecture-review-workflow
description: Multi-agent architecture review workflow with parallel security analysis（通过 code-review 调用）
version: 1.0.0
agents: [architect, code-reviewer, developer, researcher]
phases: 4
complexity: medium-to-high
triggers:
  - architecture review (via code-review)
  - codebase assessment
  - technical debt analysis
  - system health check
---

# Architecture Review Workflow

Multi-agent architecture review with parallel security analysis. Spawns specialized agents through four phases — from context gathering through analysis, security review, and actionable recommendations.

## Overview

| Phase | Agent | 目标 |
|:------|:------|:------|
| **Phase 1**: Context Gathering | Developer | 了解代码库结构 + 审计现有文档 |
| **Phase 2**: Architecture Analysis | Architect | 架构模式分析 + 质量指标 + 技术债评估 |
| **Phase 3**: Security Review | Security Architect | STRIDE 威胁建模 + OWASP + 依赖扫描 |
| **Phase 4**: Recommendations | Code Reviewer | 汇总发现 → 优先级建议 + 路线图 |

**执行顺序**: Phase 1 → (Phase 2 ‖ Phase 3) → Phase 4

## When to Use

**推荐场景:**
- 重大功能开发前（验证架构是否支持新功能）
- 代码库重大变更后（确保架构完整性）
- 技术债评估周期
- 安全审计准备
- 事故后分析

**复杂度指示:**

| Indicator | Simple | Full |
|-----------|--------|------|
| Codebase | < 10k LOC | > 10k LOC |
| Services | Monolith | Multi-service |
| Team | 1-3 | 4+ |
| Security | Low | Medium-High |

---

## Phase 1: Context Gathering

**目标**: 构建代码库的全面理解。
**Agent**: Developer (exploration mode)

- 1.1 代码库结构探索 — 目录结构、组件、技术栈、依赖图
- 1.2 文档审计 — README/ADR/API 文档覆盖度和时效性

→ 详见 [`architecture-review/phase1-context-gathering.md`](architecture-review/phase1-context-gathering.md)

---

## Phase 2: Architecture Analysis

**目标**: 深入分析架构模式、质量指标和技术债。
**Agent**: Architect
**前置**: Phase 1 完成

- 2.1 模式分析 — 分层/六边形/微服务，SOLID，耦合/内聚
- 2.2 技术债评估 — 代码/设计/基础设施/文档债

→ 详见 [`architecture-review/phase2-architecture-analysis.md`](architecture-review/phase2-architecture-analysis.md)

---

## Phase 3: Security Review

**目标**: 识别安全漏洞和合规缺口。
**Agent**: Security Architect
**前置**: Phase 1 完成（可与 Phase 2 并行）

- 3.1 安全态势评估 — STRIDE 威胁建模、OWASP Top 10
- 3.2 依赖安全扫描 — CVE 数据库比对

→ 详见 [`architecture-review/phase3-security-review.md`](architecture-review/phase3-security-review.md)

---

## Phase 4: Recommendations

**目标**: 汇总所有发现为可执行建议。
**Agent**: Code Reviewer（合成模式）
**前置**: Phase 2 和 Phase 3 完成

- 4.1 发现汇总 — 去重、按影响/安全/维护成本排序
- 输出: 总览评分 + 分类发现 + 优先级路线图

→ 详见 [`architecture-review/phase4-recommendations.md`](architecture-review/phase4-recommendations.md)

---

## Success Criteria

- [ ] Codebase structure fully documented
- [ ] All major components and their interactions identified
- [ ] Architectural patterns analyzed with quality scores
- [ ] Technical debt cataloged and prioritized
- [ ] Security posture assessed with threat model
- [ ] Dependencies scanned for vulnerabilities
- [ ] Findings consolidated into actionable recommendations
- [ ] Executive summary prepared for stakeholders
- [ ] Remediation roadmap created with timeline

## Error Recovery

| Phase | 故障 | 恢复策略 |
|:------|:-----|:---------|
| 1 | 代码库太大 | 按域拆分探索，并行 explorer，设深度上限 |
| 1 | 文档缺失 | 记录缺口，基于代码分析，把文档列为高优建议 |
| 2 | 无法识别模式 | 检查是否代码库太小，记录为 "pattern-free" |
| 2 | 复杂度分析超时 | 聚焦 hotspot + 采样 + 优先最近变更 |
| 3 | 安全扫描不完整 | 记录扫描范围，标记缺口为手动审查项 |
| 3 | 依赖扫描失败 | 检查不支持的包管理器，回退手动审查 |
| 4 | 冲突建议 | Architect 仲裁，记录 trade-off 供决策 |

## Execution Parameters

| 参数 | 描述 | 默认 |
|:-----|:-----|:------|
| `--project-root` | 项目根目录绝对路径 | 必填 |
| `--scope` | 审查范围（full/focused） | full |
| `--focus-areas` | 优先关注领域列表 | — |
| `--exclude-paths` | 排除路径 | — |
| `--security-level` | 安全审查深度（basic/standard/deep） | standard |
| `--parallel-explorers` | 并行探索 agent 数量 | 1 |
| `--output-format` | 报告格式（markdown/html/json） | markdown |

## Agent-Skill Mapping

| Phase | Agent | Required Skills |
|:------|:------|:----------------|
| 1.1 | developer | code-analyzer, project-onboarding |
| 1.2 | developer | — |
| 2.1 | architect | code-analyzer |
| 2.2 | architect | code-analyzer |
| 3.1 | security-architect | security-architect |
| 3.2 | security-architect | — |
| 4.1 | code-reviewer | — |

## Related Workflows

- **hdl-coding-workflow.md** — Phase 6 代码审查（可能升级为此工作流）
- **code-review-workflow.md** — 常规代码审查（轻量级）
- **security-review-workflow.md** — 独立安全审查（专注安全维度）
