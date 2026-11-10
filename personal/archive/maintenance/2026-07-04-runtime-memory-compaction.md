---
name: runtime-memory-compaction-2026-07-04
description: Distilled cleanup summary for transient runtime memory, agent eval workspaces, and HDL harness directory regression.
created: 2026-07-04
type: maintenance
tags: [maintenance, memory, compaction, agent-eval, hdl]
---

# Runtime Memory Compaction 2026-07-04

## Scope

This entry replaces transient local records from `memory/work/`,
`memory/errors/*-hook_failure_*.md`, and ignored runtime/eval workspaces. Raw
success logs, temporary eval folders, caches, and simulator/debug artifacts are
not useful retrieval material once their lesson is distilled.

## Distilled Lessons

- Direct-tool Claude Code can complete the task but may omit the required
  visible pre-tool checklist. Treat this as compliance failure even when
  functionality passes.
- Managed-action mode remains the reliable workflow: the agent returns an
  auditable JSON plan, the harness validates path/gate/checklist protocol, and
  the harness owns writes and verification.
- Codex on this machine should use the npm fallback when WindowsApps `codex`
  is access denied: `npx -y @openai/codex@0.142.5`.
- Directory-contract regression must test both dimensions:
  protocol compliance (exact checklist labels, canonical paths) and functional
  completion (expected files and `var/project-init/directory-contract.json`).
- Claude's directory scenario chose canonical paths but failed the exact label
  form once; the prompt now requires copying the four-line checklist into every
  `checklistText` field and repairs prior paraphrase failures explicitly.
- Raw hook failure fragments from FSK debug runs are simulator churn, not
  durable memory. Keep only root causes and final verified fixes.
- Knowledge source literature should not be deleted merely because it is large.
  Delete only duplicate/empty sources after `sources-index.md` and refined
  primary summaries point to a canonical surviving source.

## Cleanup Policy

- Delete ignored caches: `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`.
- Delete ignored eval/run outputs under `var/agent-evals/` only after they are
  not used as fixed regression evidence. Current implementation artifacts are
  retained until they move into committed fixtures; stale logs, coverage,
  maintenance output, and lock files can be removed immediately.
- Delete auto success/error fragments after they are summarized here or in
  `2026-07-03-hook-failure-distillation.md`.
- Keep plugin caches and user-installed plugin directories intact unless the
  user explicitly asks to reinstall plugins.

## Verification Requirement

After cleanup, run the harness tests before commit/push. At minimum:

- `node --check engine/scripts/test-hooks/hdl-project-directory-eval.cjs`
- `node engine/scripts/test-hooks/hdl-project-directory-eval.cjs --dry-run`
- `node engine/scripts/test-hooks/run-all-tests.cjs`
