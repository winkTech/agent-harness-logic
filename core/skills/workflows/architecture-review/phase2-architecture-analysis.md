# Phase 2: Architecture Analysis

> 所属工作流: `workflows/architecture-review-workflow.md`
> 目标: 深入分析架构模式、质量指标和技术债。
> Agent: Architect
> 前置条件: Phase 1 完成

## Step 2.1: Pattern Analysis

```javascript
Task({
  task_id: 'task-3',
  subagent_type: 'developer',
  model: 'opus',
  description: 'Analyzing architectural patterns and quality',
  prompt: `You are the ARCHITECT agent.

## PROJECT CONTEXT
PROJECT_ROOT: $PROJECT_ROOT

## Task
Analyze architectural patterns and quality metrics.

## Instructions
1. Read your agent definition: .claude/agents/core/architect.md
2. Read Phase 1 outputs:
   - .claude/context/exploration/architecture-review-structure.md
   - .claude/context/exploration/architecture-review-docs.md
3. **Invoke skills**: Skill({ skill: "code-analyzer" })
4. Analyze against established patterns:
   - Layered architecture / Hexagonal / Microservices
   - SOLID principles adherence
   - DRY/KISS/YAGNI compliance
5. Assess coupling, cohesion, and modularity
6. Identify architectural anti-patterns and smell indicators
7. Save analysis to: .claude/context/reports/architecture/architecture-review-patterns.md

## Analysis Framework
| Dimension | Indicators | Rating Scale |
|-----------|-----------|--------------|
| Modularity | Clear boundaries, single responsibility | 1-5 |
| Coupling | Dependency direction, abstraction levels | 1-5 |
| Cohesion | Related functionality grouping | 1-5 |
| Extensibility | Plugin points, configuration | 1-5 |
| Testability | Dependency injection, isolation | 1-5 |

## Output Format
- Pattern identification (what patterns are used)
- Pattern adherence score (how well followed)
- Anti-pattern catalog with locations
- Complexity hotspots map

## Memory Protocol
1. Read .claude/context/memory/learnings.md first
2. Record architectural decisions to .claude/context/memory/decisions.md
`,
});
```

**Expected Output**: Pattern analysis with quality metrics and anti-pattern catalog.

## Step 2.2: Technical Debt Assessment

```javascript
Task({
  task_id: 'task-4',
  subagent_type: 'developer',
  description: 'Assessing technical debt and maintenance burden',
  prompt: `You are the ARCHITECT agent.

## PROJECT CONTEXT
PROJECT_ROOT: $PROJECT_ROOT

## Task
Assess technical debt and maintenance burden.

## Instructions
1. Read your agent definition: .claude/agents/core/architect.md
2. Read pattern analysis: .claude/context/reports/architecture/architecture-review-patterns.md
3. **Invoke skill**: Skill({ skill: "code-analyzer" })
4. Identify and categorize technical debt:
   - Code debt (duplication, complexity, outdated patterns)
   - Design debt (poor abstractions, tight coupling)
   - Infrastructure debt (outdated dependencies, missing automation)
   - Documentation debt (stale docs, missing comments)
5. Estimate remediation effort for each item
6. Prioritize based on impact and effort
7. Save assessment to: .claude/context/reports/architecture/architecture-review-techdebt.md

## Debt Categorization Matrix
| Category | Impact | Effort | Priority |
|----------|--------|--------|----------|
| Critical | Blocks development | Any | P0 |
| High | Slows development | Low-Medium | P1 |
| Medium | Causes bugs | Low | P2 |
| Low | Aesthetic | Low | P3 |

## Output Format
- Technical debt inventory
- Impact assessment per item
- Remediation effort estimates
- Prioritized backlog

## Memory Protocol
1. Record critical debt to .claude/context/memory/issues.md
`,
});
```

**Expected Output**: Technical debt inventory with prioritization.

**Phase 2 Deliverables**:
- `architecture-review-patterns.md` — Pattern analysis and quality metrics
- `architecture-review-techdebt.md` — Technical debt assessment
