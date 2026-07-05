---
name: harness-failure-distillation-2026-07-05
description: Distilled summary of 60+ project-practice agent/harness failures compressed into durable policy.
created: 2026-07-05
type: maintenance
tags: [maintenance, memory, compaction, harness, false-positive, rtl]
---

# Harness Failure Distillation 2026-07-05

## Scope

This entry replaces the useful content of 60+ transient project-practice error
records and repeated live-agent debugging observations. Raw hook failure files,
temporary run folders, and simulator churn are not durable retrieval material
once the policy and regression tests capture the root cause.

## Compressed Lessons

- The primary historical failure mode was false convergence: the agent produced
  plausible process artifacts while the real RTL/data-path behavior remained
  wrong.
- A second recurring failure mode was ungrounded verification language:
  `verified`, `pass`, and `synthesis passed` appeared without trustworthy tool
  logs.
- Directory compliance and file boundary compliance are necessary but not
  sufficient. Content semantics and evidence provenance must be checked.
- Claude Code + DeepSeek should not own open-ended HDL projects end to end.
  It should receive narrow repair contracts and return patch plans only.
- Codex should remain the main harness maintainer and quality gate owner:
  inspect logs first, repair deterministic gates, and distrust self-reported
  success.
- Tool environment failures must be categorized separately from implementation
  failures to avoid debugging the wrong layer.
- Memory maintenance should retain distilled root causes, verified fixes, and
  harness policy changes; raw auto-recorded failures should be pruned after
  regression evidence is committed.

## Durable Artifacts Replacing Raw Failures

- `memory/learnings/harness-verification-dynamics.md`
- `engine/scripts/lib/harness-metrics.cjs`
- `engine/scripts/test-hooks/harness-metrics-eval.cjs`
- `engine/scripts/test-hooks/claude-patch-eval.cjs` harness cases and metrics
- `schemas/harness-eval-case.schema.json`

## Retention Decision

Keep this summary and the learning note. Delete or ignore raw runtime fragments
that only repeat the above symptoms. Keep curated `memory/errors/*.md` entries
only when they contain a unique root cause not captured here.
