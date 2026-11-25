# Phase 3: Security Review

> 所属工作流: `workflows/architecture-review-workflow.md`
> 目标: 识别安全漏洞和合规缺口。
> Agent: Security Architect
> 前置条件: Phase 2 完成（可与 Phase 2 并行执行）

## Step 3.1: Security Posture Assessment

```javascript
Task({
  task_id: 'task-5',
  subagent_type: 'developer',
  model: 'opus',
  description: 'Security architecture review',
  prompt: `You are the SECURITY-ARCHITECT agent.

## PROJECT CONTEXT
PROJECT_ROOT: $PROJECT_ROOT

## Task
Perform comprehensive security architecture review.

## Instructions
1. Read your agent definition: .claude/agents/specialized/security-architect.md
2. Read Phase 1 outputs:
   - .claude/context/exploration/architecture-review-structure.md
3. **Invoke skill**: Skill({ skill: "security-architect" })
4. Apply STRIDE threat modeling:
   - Spoofing, Tampering, Repudiation
   - Information Disclosure, Denial of Service
   - Elevation of Privilege
5. Check OWASP Top 10 vulnerabilities
6. Review authentication and authorization patterns
7. Assess data protection (encryption, masking, retention)
8. Identify attack surfaces and trust boundaries
9. Save findings to: .claude/context/reports/architecture/architecture-review-security.md

## Security Checklist
- [ ] Authentication mechanisms reviewed
- [ ] Authorization patterns validated
- [ ] Input validation assessed
- [ ] Cryptographic implementations checked
- [ ] Secrets management evaluated
- [ ] Logging and audit trails verified
- [ ] Error handling reviewed (no info leakage)
- [ ] Dependency vulnerabilities scanned

## Output Format
- Threat model (STRIDE analysis)
- Vulnerability catalog with severity
- Attack surface map
- Trust boundary diagram
- Remediation recommendations

## Memory Protocol
1. Read .claude/context/memory/learnings.md first
2. Record security issues to .claude/context/memory/issues.md
`,
});
```

**Expected Output**: Security assessment with threat model and vulnerability catalog.

## Step 3.2: Dependency Security Scan

```javascript
Task({
  task_id: 'task-6',
  subagent_type: 'developer',
  description: 'Scanning dependencies for known vulnerabilities',
  prompt: `You are the SECURITY-ARCHITECT agent.

## PROJECT CONTEXT
PROJECT_ROOT: $PROJECT_ROOT

## Task
Scan dependencies for security vulnerabilities.

## Instructions
1. Read your agent definition: .claude/agents/specialized/security-architect.md
2. Identify all dependency manifests:
   - package.json, requirements.txt, go.mod, Cargo.toml, etc.
3. Check dependencies against CVE databases
4. Identify outdated dependencies with known vulnerabilities
5. Assess transitive dependency risks
6. Create upgrade recommendations
7. Save scan results to: .claude/context/reports/architecture/architecture-review-deps.md

## Output Format
- Dependency inventory with versions
- Known vulnerabilities (CVE references)
- Risk severity ratings
- Upgrade recommendations

## Memory Protocol
1. Record critical vulnerabilities to .claude/context/memory/issues.md
`,
});
```

**Expected Output**: Dependency security scan with CVE findings.

**Phase 3 Deliverables**:
- `architecture-review-security.md` — Security posture assessment
- `architecture-review-deps.md` — Dependency vulnerability scan
