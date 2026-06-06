# Phase 4: Recommendations

> 所属工作流: `workflows/architecture-review-workflow.md`
> 目标: 汇总所有发现为可执行建议。
> Agent: Code Reviewer（合成模式）
> 前置条件: Phase 2 和 Phase 3 完成

## Step 4.1: Findings Consolidation

```javascript
Task({
  task_id: 'task-7',
  subagent_type: 'developer',
  description: 'Consolidating architecture review findings',
  prompt: `You are the CODE-REVIEWER agent.

## PROJECT CONTEXT
PROJECT_ROOT: $PROJECT_ROOT

## Task
Consolidate all architecture review findings into actionable recommendations.

## Instructions
1. Read your agent definition: .claude/agents/specialized/code-reviewer.md
2. Read all previous phase outputs:
   - .claude/context/exploration/architecture-review-structure.md
   - .claude/context/exploration/architecture-review-docs.md
   - .claude/context/reports/architecture/architecture-review-patterns.md
   - .claude/context/reports/architecture/architecture-review-techdebt.md
   - .claude/context/reports/architecture/architecture-review-security.md
   - .claude/context/reports/architecture/architecture-review-deps.md
3. Synthesize findings across all dimensions
4. Remove duplicates and consolidate related issues
5. Create unified prioritization based on:
   - Business impact (feature velocity, reliability)
   - Security risk (vulnerability severity)
   - Technical debt cost (maintenance burden)
6. Generate executive summary for stakeholders
7. Save consolidated report to: .claude/context/reports/architecture/architecture-review-final.md

## Output Format (architecture-review-final.md)

### Executive Summary
- Overall health score (A-F rating)
- Top 3 critical findings
- Recommended immediate actions

### Findings by Category
| Category | Finding Count | Critical | High | Medium | Low |
|----------|--------------|----------|------|--------|-----|
| Architecture | N | X | Y | Z | W |
| Security | N | X | Y | Z | W |
| Technical Debt | N | X | Y | Z | W |

### Prioritized Recommendations
1. [P0] Critical - Immediate action required
2. [P1] High - Address within 1 sprint
3. [P2] Medium - Address within 1 quarter
4. [P3] Low - Backlog for future consideration

### Roadmap Suggestion
- Week 1-2: Critical security fixes
- Month 1: High-priority refactoring
- Quarter 1: Technical debt reduction
- Ongoing: Documentation improvements

## Memory Protocol
1. Record key decisions to .claude/context/memory/decisions.md
2. Record learnings to .claude/context/memory/learnings.md
`,
});
```

**Expected Output**: Consolidated architecture review report with prioritized recommendations.

**Phase 4 Deliverables**:
- `architecture-review-final.md` — Complete review with recommendations
