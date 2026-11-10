## Test Runner Selection (node --test vs Vitest 4)

Agent Studio uses `node --test` (built-in Node.js test runner) as the **default** for all `.cjs` CommonJS files (hooks, lib, scripts). Vitest 4 is the recommended runner for ESM/TypeScript files.

| Runner        | Use When                                                            | Command                           |
| ------------- | ------------------------------------------------------------------- | --------------------------------- |
| `node --test` | `.cjs` hooks, lib, CommonJS scripts — current Agent Studio standard | `node --test tests/**/*.test.cjs` |
| `vitest`      | `.ts`, `.mts`, ESM `.js` files — use when migrating to TypeScript   | `pnpm vitest run`                 |

**Why `node --test` for `.cjs`:** Vitest requires Vite configuration and ESM-compatible modules. Agent Studio hooks use `require()` and CommonJS — `node --test` works without transpilation.

**Why Vitest 4 for `.ts`/ESM:** Boot time drops from ~8s (Jest) to ~1.2s (Vitest). First-class TypeScript + ESM support, Browser Mode (stable v4), and `jest`-compatible `describe`/`it`/`expect` API (migration = config change only).

**Anti-pattern:** Do NOT use Jest for new files. Vitest is the 2025-2026 standard for ESM/TypeScript.

```bash
# Current Agent Studio pattern (CJS hooks and lib)
node --test tests/lib/routing/routing-table.test.cjs

# Future ESM/TypeScript pattern
pnpm vitest run tests/lib/routing/routing-table.test.ts
```

## AI Output Evaluation Testing (Non-Deterministic Agents)
