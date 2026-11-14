### Step 5.5: Property-Based Testing (recommended for utility functions and security hooks)

After refactor (or after Step 4 for security-critical code), consider supplementing example-based tests with property-based tests. PBT achieves 23.1–37.3% pass@1 improvement over example-based TDD alone for LLM code generation (arXiv:2506.18315) by breaking the self-deception cycle.

**When to invoke:**

- Utility functions (encode/decode, parsers, serializers, calculators)
- Security hooks (input validators, sanitizers, access control logic)
- Any function where invariants, round-trip properties, or mathematical properties can be stated

**Invocation:**

```javascript
Skill({ skill: 'property-based-testing' });
```

**Key property patterns to identify:**

| Pattern                | Example                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| Round-trip             | `decode(encode(x)) === x`                                               |
| Idempotence            | `normalize(normalize(x)) === normalize(x)`                              |
| Invariant              | `sort(arr).length === arr.length`                                       |
| Fail-closed (security) | `securityHook(anyInput).allow !== true` (unless explicitly whitelisted) |

PBT is a supplement to Canon TDD, not a replacement. Canon RED/GREEN/REFACTOR completes first; PBT runs after GREEN is confirmed.

### Step 6: Repeat until backlog empty
