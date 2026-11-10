# Pass 1: Correctness Review (Blocking)

> 所属工作流: `workflows/code-review-workflow.md`
> Pass 1 阻塞性审查 — 不通过则不能合并，不能进入 Pass 2。

## 1.1 Specification Compliance

**Check:**
- [ ] All acceptance criteria from implementation plan met
- [ ] API contracts match design spec
- [ ] Data models match schema definitions
- [ ] Performance requirements achieved
- [ ] Security requirements implemented

**Process:**
1. Read implementation plan
2. Read technical spec
3. Compare implementation against each requirement
4. Create checklist of missing requirements

**Output:**
```markdown
### Specification Compliance

**Status:** ❌ BLOCKING ISSUES FOUND

**Missing Requirements:**
1. Acceptance Criterion #3: "..."
   - Location: no endpoint found
   - Fix: implement ...
```

---

## 1.2 Logic Correctness

**Check:**
- [ ] Algorithm implementations correct
- [ ] Business logic matches requirements
- [ ] State transitions valid
- [ ] Calculations accurate
- [ ] Conditionals cover all paths

**Common Logic Errors:**
- Off-by-one errors in loops
- Incorrect comparison operators
- Missing null/undefined checks
- Race conditions in async code
- Integer overflow/underflow

**Output:**
```markdown
### Logic Correctness

**Status:** ❌ BLOCKING ISSUES FOUND

**Logic Errors:**
1. Off-by-one in pagination
   - File: `src/api/users.ts:45`
   - Fix: Adjust loop condition
```

---

## 1.3 Edge Case Handling

**Check:**
- [ ] Empty input handling
- [ ] Null/undefined handling
- [ ] Boundary values (min, max, zero, negative)
- [ ] Concurrency and race conditions
- [ ] Network failures and timeouts
- [ ] Database constraint violations

**Categories:**

| Category | Examples |
|----------|---------|
| **Input** | Empty, null, undefined, whitespace-only |
| **Numeric** | Zero, negative, MAX_INT, MIN_INT |
| **Collections** | Empty array, single item, large dataset (10k+) |
| **Async** | Timeout, network failure, concurrent requests |
| **Database** | Constraint violation, deadlock, connection loss |

**Output:**
```markdown
### Edge Case Handling

**Status:** ⚠️ WARNINGS

**Missing Edge Cases:**
1. Empty input not handled
   - File: `src/utils/validator.ts:23`
   - Fix: Add `if (!email?.trim()) return false;`
```

---

## 1.4 Security Review

**Check (OWASP Top 10):**
- [ ] A01: Broken Access Control
- [ ] A02: Cryptographic Failures
- [ ] A03: Injection
- [ ] A04: Insecure Design
- [ ] A05: Security Misconfiguration
- [ ] A06: Vulnerable Components
- [ ] A07: Authentication Failures
- [ ] A08: Data Integrity
- [ ] A09: Logging Failures
- [ ] A10: SSRF

**Escalation**: 安全敏感变更（auth/payment/PII）升级到 security-architect 深度审查。

**Output:**
```markdown
### Security Review

**Status:** 🔴 CRITICAL ISSUES FOUND

**Security Findings:**
1. A03: SQL Injection (CRITICAL)
   - File: `src/db/queries.ts:34`
   - Fix: Use parameterized query
```

---

## 升级触发条件

Pass 1 审查过程中发现以下情况时，必须在审查报告中标记升级建议：

| 发现类型 | 升级目标 | 判定条件 |
|:---------|:---------|:---------|
| 架构设计缺陷 | → architecture-review | 模块划分不合理、接口耦合过紧、无清晰分层 |
| 设计模式引入 | → architecture-review | 新引入微服务/CQRS/事件驱动等架构模式 |
| 数据库 schema 变更 | → architecture-review | 表创建/列变更/索引新增 |
| CRITICAL 安全漏洞 | → security-review | OWASP A01-A03 等严重漏洞 |
| 敏感数据处理 | → security-review | auth/token/password/加密实现 |
| 第三方依赖漏洞 | → security-review | 已知 CVE 且无法简单升级 |

> **规则**: 至少标记 1 个升级目标后，方可进入 Pass 2。

---

## Pass 1 Summary Template

```markdown
## Pass 1: Correctness Review

**Overall Status:** ❌ BLOCKING / ✅ APPROVED / ⚠️ WARNINGS ONLY

**Summary:**
- Specification Compliance: X issues
- Logic Correctness: X issues
- Edge Case Handling: X issues
- Security Review: X issues

**Escalation:**
- → architecture-review: [Yes/No — reason]
- → security-review: [Yes/No — reason]

**Total Blocking Issues:** X

### Blocking Issues (Must Fix Before Merge)
1. ...

### Non-blocking Warnings (Recommend Fix)
1. ...

### Next Steps
- [ ] Developer fixes blocking issues
- [ ] Proceed to Pass 2 (Code Quality)
- [ ] Escalate to [architecture-review / security-review] if flagged
```
