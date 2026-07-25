# Harness Unified Architecture Design

## Decision

Option C is approved. The Harness will use one portable root/config resolver, one functional regression entry, fail-closed evidence rules, a real CI gate, and an actual Schema catalog. The existing Claude permission experience remains unchanged.

## Alternatives considered

- Option A: repair only credentials, CI, and metrics. Lowest cost, but leaves multiple configuration and evidence owners.
- Option B: repair trust first and clean architecture later. Safer rollout, but keeps drift during the transition.
- Option C: unify the architecture now. Highest change surface, but removes the duplicated root, registration, evidence, and CI contracts that caused the audit failures.

## Architecture

`harness-root.cjs` resolves the Harness installation from an explicit override, a caller-provided start path, the module location, or `~/.claude`. `hook-registry.cjs` owns settings loading and hook reference validation. `run-all-tests.cjs` is the functional source of truth locally and in CI, supports non-persistent execution, propagates child failures, and applies configured Harness metric targets. GitHub Actions runs that same entry without `|| true`.

Schema inventory is machine-readable in `engine/schemas/catalog.json`; the README describes only present files and their real consumers. Runtime credentials, daemon state, caches, and updater results are excluded from version control.

## Compatibility boundary

- Do not change `settings.local.json` permission ask/allow/deny/defaultMode values.
- Preserve existing CLI defaults and human-readable test output.
- Keep optional legacy gates explicit and bounded; absence may be skipped locally only when listed by exact test ID.
- Preserve unrelated dirty-worktree edits.

## Verification

- Node syntax and JSON parsing across framework files.
- Root resolution from both the installed `~/.claude` path and an arbitrary checkout path.
- Hook registry: no missing references and no duplicate effective entries.
- Metrics: configured targets fail when samples are absent.
- E2E: nonzero or timed-out child processes cannot pass from stdout text.
- Full Harness regression and CI-equivalent commands complete with zero failures.
