---
name: code-review-workflow
description: Two-pass code review process for systematic quality validation.
triggers:
  - pull request created
  - code review requested
  - code review prep (Phase 6)
agents:
  - code-reviewer
---

# Code Review Workflow

Two-pass code review process ensuring spec compliance, logic correctness, security, and code quality.

## Overview

| Pass | 类型 | 结果 |
|:----|:-----|:------|
| **Pass 1: Correctness** | 阻塞性 | 规格合规 + 逻辑正确 + 边界处理 + 安全审查 → 零阻塞才进入 Pass 2 |
| **Pass 2: Code Quality** | 建议性 | 代码质量 + 风格 + DRY + 命名 + 文档 → 所有结果非阻塞 |

## Pass 1: Correctness Review (Blocking)

审查四大维度：
- **1.1 规格合规** — 实现是否满足需求规格
- **1.2 逻辑正确** — 算法、业务逻辑、状态转移
- **1.3 边界处理** — 空值/边界/并发/异常
- **1.4 安全审查** — OWASP Top 10

→ 详见 [`code-review/pass1-correctness.md`](code-review/pass1-correctness.md)

**通过条件**: 零阻塞问题（无 CRITICAL/HIGH severity 未解决）。

## Pass 2: Code Quality Review (Non-blocking)

审查五大维度：
- **2.1 代码结构** — 函数长度、圈复杂度、SRP
- **2.2 风格一致性** — 命名规范、缩进、import 顺序
- **2.3 DRY** — 重复代码、魔数抽取
- **2.4 命名可读性** — 语义化命名、动词函数名
- **2.5 文档** — JSDoc、README、CHANGELOG

→ 详见 [`code-review/pass2-code-quality.md`](code-review/pass2-code-quality.md)

**通过条件**: Pass 1 已通过，所有发现项为建议，不阻塞合并。

## Integration with Architecture Review

### When to Escalate

以下情况升级到 architect agent：
- 新设计模式/框架/库引入
- 数据库 schema 变更
- API 契约变更（breaking changes）
- 横切关注点（auth/日志/缓存）
- 架构决策（微服务/CQRS/事件驱动）

### Escalation Process

1. code-reviewer 识别架构问题
2. 创建新任务交给 architect
3. architect 审查设计并提建议
4. 开发者实现 architect 建议
5. code-reviewer 复核

## Output Format

### Severity Levels

| Severity | Description | Action |
|----------|-------------|--------|
| CRITICAL | 安全漏洞/数据丢失风险 | BLOCK merge |
| HIGH | 逻辑错误/缺失需求 | BLOCK merge |
| MEDIUM | 边界情况缺失/代码质量问题 | Recommend fix |
| LOW | 风格/小改进 | Optional |

### Finding Template

```markdown
### {Category} ({Severity})
**File:** {path:line}
**Issue:** {Description}
**Impact:** {What happens if not fixed}
**Fix:** {Specific recommendation}
```

## Success Criteria

### Pass 1 (Required for Pass 2)
- [ ] All specification requirements met
- [ ] No logic errors found
- [ ] Critical edge cases handled
- [ ] Zero security vulnerabilities (CRITICAL/HIGH)
- [ ] Zero blocking issues

### Pass 2 (Required for Approval)
- [ ] Code quality meets standards (complexity ≤10, functions ≤50 lines)
- [ ] Style consistent with project conventions
- [ ] No significant code duplication
- [ ] Clear naming throughout
- [ ] Public APIs documented

### Overall
- [ ] Pass 1 approved (0 blocking issues)
- [ ] Pass 2 completed (recommendations provided)
- [ ] Review findings report generated

## Related Workflows

- **hdl-coding-workflow.md** — Phase 6 调用此工作流
- **architecture-review-workflow.md** — 架构问题升级路径

## Memory Protocol

**Before starting:** Read learnings from prior reviews.

**After completing:**
- New review pattern → learnings
- Common bug found → issues
- Review decision rationale → decisions
