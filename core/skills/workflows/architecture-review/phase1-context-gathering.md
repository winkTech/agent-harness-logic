# Phase 1: Context Gathering

> 所属工作流: `workflows/architecture-review-workflow.md`
> 目标: 在分析前全面了解代码库。
> Agent: Developer（探索模式）

## Step 1.1: Codebase Structure Exploration

```javascript
Task({
  task_id: 'task-1',
  subagent_type: 'developer',
  description: 'Exploring codebase structure for architecture review',
  prompt: `You are the DEVELOPER agent in exploration mode.

## PROJECT CONTEXT (CRITICAL)
PROJECT_ROOT: $PROJECT_ROOT
All file operations MUST be relative to PROJECT_ROOT.

## Task
Explore codebase structure to gather context for architecture review.

## Instructions
1. Read your agent definition: .claude/agents/core/developer.md
2. **Invoke skills**:
   - Skill({ skill: "code-analyzer" })
   - Skill({ skill: "project-onboarding" })
3. Map directory structure, identify major components and modules
4. Catalog technologies, frameworks, and external dependencies
5. Identify entry points, API boundaries, and data flow paths
6. Document build system, configuration, and deployment artifacts
7. Save findings to: .claude/context/exploration/architecture-review-structure.md

## Output Format
- Directory tree with component descriptions
- Technology stack summary
- Dependency graph (major components)
- Entry point catalog

## Memory Protocol
1. Read .claude/context/memory/learnings.md first
2. Record discoveries to .claude/context/memory/learnings.md
`,
});
```

**Expected Output**: Codebase map with technology stack, component boundaries, and dependency graph.

## Step 1.2: Documentation Audit

```javascript
Task({
  task_id: 'task-2',
  subagent_type: 'developer',
  description: 'Auditing existing architecture documentation',
  prompt: `You are the DEVELOPER agent.

## PROJECT CONTEXT
PROJECT_ROOT: $PROJECT_ROOT

## Task
Audit existing architecture documentation.

## Instructions
1. Read your agent definition: .claude/agents/core/developer.md
2. Search for existing documentation:
   - README files, architecture decision records (ADRs)
   - API documentation, design documents
   - Diagrams (C4, sequence, ERD)
3. Assess documentation completeness and currency
4. Identify gaps between documented and actual architecture
5. Save findings to: .claude/context/exploration/architecture-review-docs.md

## Output Format
- Documentation inventory
- Coverage assessment (0-100%)
- Currency assessment (stale/current)
- Gap analysis

## Memory Protocol
1. Record documentation gaps to .claude/context/memory/issues.md
`,
});
```

**Expected Output**: Documentation inventory with gap analysis.

**Phase 1 Deliverables**:
- `architecture-review-structure.md` — Codebase structure analysis
- `architecture-review-docs.md` — Documentation audit results
