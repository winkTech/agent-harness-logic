---
name: hook-failure-distillation-2026-07-03
description: Distilled summary of transient auto-recorded hook failure logs removed during harness maintenance.
created: 2026-07-03
type: maintenance
tags: [maintenance, memory, compaction, hook-failure]
---

# Hook Failure Distillation 2026-07-03

## Scope

This summary distills 29 untracked `memory/errors/*-hook_failure_*.md`
auto-record files generated while validating the harness. The raw files were
short transient tool-failure logs, mostly duplicate symptoms, and were removed
after this summary was written so they do not pollute long-term retrieval.

Tracked curated error memories under `memory/errors/` were kept.

## Distilled Patterns

- HDL red-line scanner found legacy `assign ro_` patterns in old RTL examples.
- Several path quoting mistakes collapsed Windows paths such as
  `engine\scripts\test-hooks\...` into invalid module names.
- Python/pytest contract failures appeared during managed-action fixture
  development before the verifier and retry loop stabilized.
- Temporary live-eval workspaces were later missing, producing repeated
  `File does not exist` logs for `rtl-live-claude-*` paths.
- One directory/file mismatch produced `EISDIR`.
- A few command probes exited with generic status codes during CLI readiness
  and environment checks.

## Result

The useful lesson is captured in durable harness docs and eval manifests:
transient hook failures should not be indexed as long-term memory. Keep
dimensioned eval manifests and maintenance summaries; prune raw auto failure
logs once the regression is fixed and verified.
