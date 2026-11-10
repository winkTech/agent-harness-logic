## Autonomous TDD with ralph-loop (Session-Persistent Iteration)

For repository-scale TDD where sessions may be interrupted, wire ralph-loop (Mode 2 — router-managed) to maintain the TDD scenario backlog across interruptions:

### TDD State Schema

Maintain a TDD-specific state file at `var/tdd/tdd-state.json`:

```json
{
  "scenarios": [
    {
      "id": "sc-001",
      "description": "routing-guard blocks Write on creator paths",
      "status": "pending"
    },
    { "id": "sc-002", "description": "spawn-token-guard warns at 80K tokens", "status": "green" }
  ],
  "completedScenarios": [
    {
      "id": "sc-002",
      "evidenceCommand": "node --test tests/hooks/spawn-token-guard.test.cjs",
      "passedAt": "2026-03-12T10:00:00Z"
    }
  ],
  "currentScenario": "sc-001",
  "evidenceLog": [
    {
      "scenarioId": "sc-001",
      "phase": "red",
      "output": "AssertionError: expected exit code 2, got 0",
      "timestamp": "..."
    }
  ]
}
```

### Resume Pattern

At the start of each iteration, read the TDD state file:

```javascript
// Step 0 — before building/refreshing backlog
const state = JSON.parse(
  fs.readFileSync('var/tdd/tdd-state.json', 'utf-8') || '{}'
);
const completedIds = (state.completedScenarios || []).map(s => s.id);
const remaining = (state.scenarios || []).filter(s => !completedIds.includes(s.id));
// Pick next scenario from remaining — never re-run completed ones
```

### Integration with ralph-loop Mode 2

1. Router spawns `qa` agent with `{ task_id, subagent_type: 'qa', prompt: TDP_PROMPT + verbatim state }`
2. `qa` writes test → runs → captures output → updates `tdd-state.json` (phase: red)
3. Router spawns `developer` with TDP prompt (verbatim test output injected)
4. `developer` implements → updates `tdd-state.json` (phase: green)
5. Router checks `remaining.length === 0` → emit `RALPH_AUDIT_COMPLETE_NO_FINDINGS`
6. If remaining > 0 → loop back to step 1 with next scenario

**Anti-pattern:** Never re-run scenarios already marked `green` in state — this wastes iterations and may corrupt evidence logs.

## Repository-Scale and Class-Level Guidance
