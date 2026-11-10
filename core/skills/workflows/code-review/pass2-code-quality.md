# Pass 2: Code Quality Review (Non-blocking)

> 所属工作流: `workflows/code-review-workflow.md`
> Pass 2 仅当 Pass 1 无阻塞问题后执行。所有发现为建议项，不阻塞合并。

## 2.1 Code Quality and Structure

**Check:**
- [ ] Functions ≤ 50 lines
- [ ] Cyclomatic complexity ≤ 10
- [ ] Single Responsibility Principle followed
- [ ] No nested callbacks (max depth 2)
- [ ] Clear separation of concerns

**Output:**
```markdown
### Code Quality

**Status:** ⚠️ RECOMMENDATIONS

**Quality Findings:**
1. Function too long
   - File: `src/api/users.ts:handleCreateUser()`
   - Current: 78 lines, target: ≤50
   - Recommendation: Extract validation, DB logic, formatting into separate functions

2. High cyclomatic complexity
   - File: `src/utils/validator.ts:validateInput()`
   - Current: 15, target: ≤10
   - Recommendation: Use strategy pattern or early returns
```

---

## 2.2 Style Consistency

**Check:**
- [ ] Naming conventions followed (camelCase, PascalCase, snake_case)
- [ ] Indentation consistent (2 or 4 spaces)
- [ ] Import organization (external, internal, relative)
- [ ] Linter passes with zero warnings

**Output:**
```markdown
### Style Consistency

**Status:** ⚠️ LINTER WARNINGS

**Style Findings:**
1. Inconsistent naming
   - File: `src/types/User.ts` — `UserData` should be `userData`
```

---

## 2.3 DRY (Don't Repeat Yourself)

**Check:**
- [ ] No duplicated code blocks (>5 lines)
- [ ] Common logic extracted to helpers
- [ ] Repeated patterns abstracted
- [ ] Magic numbers replaced with constants

**Output:**
```markdown
### DRY Violations

**Status:** ⚠️ RECOMMENDATIONS

**Duplication Findings:**
1. Duplicated validation logic
   - Files: `src/api/users.ts:45` and `src/api/posts.ts:67`
   - Fix: Extract to shared utility

2. Magic numbers
   - File: `src/config/rate-limit.ts:23`
   - Fix: Define named constant
```

---

## 2.4 Naming and Readability

**Check:**
- [ ] Variable names describe purpose (not type)
- [ ] Function names are verbs
- [ ] Boolean variables prefixed with is/has/can
- [ ] Class names are nouns
- [ ] Avoid abbreviations unless universally understood

**Good vs Bad:**

| Bad | Good |
|-----|------|
| `data` | `userProfile` |
| `temp` | `processedItems` |
| `flag` | `isAuthenticated` |
| `doStuff()` | `validateAndSaveUser()` |
| `Manager` | `UserAccountManager` |

**Output:**
```markdown
### Naming and Readability

**Status:** ⚠️ RECOMMENDATIONS

**Naming Findings:**
1. Unclear variable name
   - File: `src/api/auth.ts:34` — `data` → `userAccount`
2. Function name doesn't describe action
   - File: `src/handlers/payment.ts:56` — `handle()` → `processPaymentRequest()`
```

---

## 2.5 Documentation

**Check:**
- [ ] Public APIs have docstrings/JSDoc
- [ ] Complex logic has explanatory comments
- [ ] README updated if public interface changed
- [ ] API endpoints documented (OpenAPI/Swagger)
- [ ] Breaking changes noted in CHANGELOG

**Levels:**

| Level | Required Documentation |
|-------|----------------------|
| **Public API** | Full docstring (params, returns, examples) |
| **Internal** | Brief comment explaining purpose |
| **Complex** | Comment explaining "why" (not "what") |
| **Breaking** | CHANGELOG entry with migration guide |

**Output:**
```markdown
### Documentation

**Status:** ⚠️ RECOMMENDATIONS

**Documentation Findings:**
1. Missing docstring on public function
   - File: `src/api/users.ts:createUser()`
   - Fix: Add JSDoc with param types, return type, example
2. Complex logic undocumented
   - File: `src/utils/crypto.ts:hashPassword()`
   - Fix: Add comment explaining bcrypt rounds and trade-offs
```

---

## Pass 2 Summary Template

```markdown
## Pass 2: Code Quality Review

**Overall Status:** ✅ APPROVED WITH RECOMMENDATIONS

**Summary:**
- Code Quality: X findings
- Style Consistency: X findings
- DRY Violations: X findings
- Naming: X findings
- Documentation: X findings

**Total Recommendations:** X (all non-blocking)

### Recommendations (Optional Improvements)
1. ...

### Approval
✅ **Code review APPROVED**

This PR is approved for merge. Recommendations are optional improvements.
```
