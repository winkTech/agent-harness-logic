## Agent-Studio TDD Extensions (2026)

### Hook Testing Pattern

Hooks use stdin/stdout JSON protocol:

```js
const proc = require('child_process').spawn('node', ['.claude/hooks/routing/routing-guard.cjs'], {
  shell: false,
});
proc.stdin.write(JSON.stringify({ tool_name: 'Write', tool_input: {} }));
proc.stdin.end();
// Exit 0=allow, 2=block
```

### Memory TDD

Mock MemoryRecord. Test confidence gate (threshold 0.7). Use atomic writes.

### Property-Based Testing

Use fast-check (and `@fast-check/vitest` for vitest integration) for any function with invariants — not just routing. fast-check 3.x (2025) adds improved unicode, date, and bigint arbitraries.

**Routing invariant (existing):**

```js
import fc from 'fast-check';
fc.assert(
  fc.property(fc.string(), intent => {
    return typeof routeIntent(intent) === 'string';
  })
);
```

**Memory serialization roundtrip (new):**

```js
// Property: serialize(deserialize(x)) === x for all JSON-serializable values
fc.assert(
  fc.property(fc.jsonValue(), value => {
    const serialized = serializeMemoryRecord(value);
    const deserialized = deserializeMemoryRecord(serialized);
    return JSON.stringify(deserialized) === JSON.stringify(value);
  })
);
```

**Hook validation invariant (new):**

```js
// Property: for any tool input, isValidInput(x) === !isBlocked(x)
// (validation and blocking must be inverses)
fc.assert(
  fc.property(fc.record({ tool_name: fc.string(), tool_input: fc.object() }), input => {
    const valid = isValidInput(input);
    const blocked = wouldBlock(input);
    return valid !== blocked || (!valid && blocked); // blocked implies invalid
  })
);
```

**Path normalization idempotency (new):**

```js
// Property: normalize(normalize(path)) === normalize(path) (idempotent)
fc.assert(
  fc.property(fc.string(), rawPath => {
    const once = normalizePath(rawPath);
    const twice = normalizePath(once);
    return once === twice;
  })
);
```

**Schema validation stability (new):**

```js
// Property: validate(schema, x) never throws uncaught exception for any input
fc.assert(
  fc.property(fc.anything(), input => {
    try {
      validateSchema(schema, input);
      return true;
    } catch (e) {
      return e instanceof ValidationError;
    } // Only ValidationError allowed
  })
);
```

### Contract Testing

Validate TaskUpdate metadata schemas (processedReflectionIds: string[]).

## Multi-Agent TDD Decomposition (2026 Standard)
