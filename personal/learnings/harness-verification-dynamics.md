---
name: harness-verification-dynamics
description: Distilled methodology for evaluating harness as a verifier after 60+ agent-practice failures.
created: 2026-07-05
type: learning
tags: [harness, verifier, false-positive, rtl, agent-eval, memory-compaction]
---

# Harness Verification Dynamics

## Core Lesson

Treat the harness itself as a verifier. Do not ask only whether an agent run
ended with `passed`; measure whether the harness accepts true successes and
blocks false successes.

The durable metrics are:

- TPR: true-success tasks that the harness correctly allows.
- TNR: false-success tasks that the harness correctly blocks.
- Balanced Accuracy: `(TPR + TNR) / 2`.
- False Positive Rate: flawed or unverifiable outputs incorrectly accepted by
  the harness.

## Distilled Failure Patterns

- Process-looking artifacts can hide semantic failure: directories, logs, and
  claimed verification are insufficient unless tied to machine-checked evidence.
- Claude Code is useful as a narrow patch executor, not as an unconstrained HDL
  project owner. Its output should be a JSON patch plan applied by the harness.
- Stronger generators produce more coherent wrong answers. In RTL work this
  appears as plausible-looking but semantically wrong data paths, fallback logic,
  or assertions that test the wrong behavior.
- Verification must be evidence-ledger based. Agent language such as `verified`,
  `pass`, or `synthesis passed` is not evidence.
- Toolchain failures must not be confused with RTL failures. Vivado/xvlog/xsim
  loader crashes, empty-output exits, DLL/runtime failures, and license failures
  need separate classification.
- Long tasks require checkpoint evidence. Repeated reading, replanning, or
  paraphrasing without new artifacts should fail and archive the run.
- Memory should keep root causes and final verified fixes, not raw hook
  fragments or simulator churn.

## Operating Rule

For RTL and harness work, every eval case should declare:

- `difficulty`: D1/D2/D3/D4.
- `expectedHarnessVerdict`: `pass` or `block`.
- `actualHarnessVerdict`: `pass` or `block`.
- `riskCategory`: path boundary, file boundary, semantic failure, evidence
  failure, toolchain failure, progress failure, or true success.

Full regression should fail if `FalsePositiveRate > 0` for committed harness
eval cases.

## Current Canonical Pattern

Use `RepairSpec -> agent JSON patch plan -> exact harness apply -> content gate
-> command evidence ledger -> toolchain-health classification -> TPR/TNR/FPR
summary`.

This keeps Claude/Codex practically useful by narrowing their freedom while
making harness acceptance auditable.
