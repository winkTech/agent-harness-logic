## Contract Testing (Hook Boundaries — Expanded)

Hook contracts define the stdin/stdout JSON protocol. Test at the boundary:

```js
// Hook contract test pattern
const proc = spawn('node', ['.claude/hooks/routing/routing-guard.cjs'], { shell: false });
const input = JSON.stringify({
  tool_name: 'Edit',
  tool_input: { file_path: '.claude/agents/core/developer.md' },
});
proc.stdin.write(input);
proc.stdin.end();

// Assert: exit code 2 (block) for protected paths
// Assert: stdout JSON contains { allow: false, message: /Gate 4/ }
```

**TaskUpdate metadata contract:**

```js
// Validate processedReflectionIds schema
const schema = {
  type: 'object',
  required: ['processedReflectionIds'],
  properties: { processedReflectionIds: { type: 'array', items: { type: 'string' } } },
  additionalProperties: false,
};
```

**Agent-Studio hook contracts to test:**

- `routing-guard.cjs`: blocks Task without task_id (exit 2)
- `unified-creator-guard.cjs`: blocks Write to `.claude/skills/**/SKILL.md` (exit 2)
- `spawn-token-guard.cjs`: warns at 80K tokens (exit 0 + message)

## Test Runner Selection (node --test vs Vitest 4)
