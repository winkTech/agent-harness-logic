# New asset intake SOP (foundation-first)

This SOP is the entry contract for a reusable CBB asset. It does not promote
project-specific RTL by quota.

1. Register the requirement, owner, source lineage, and intended reusable
   capability in a manifest; declare `top`, ports, parameters, clock/reset,
   and source hashes.
2. Add an independent reference/fixed-point model and vectors before writing
   expected RTL results. Keep vectors outside generated build/work directories.
3. Add a module-level TB covering V-1..V-6: reset, nominal, boundary,
   backpressure, malformed input, and long-run/stability behavior.
4. Run schema validation, source registration, lint, redline, and gate-runner.
   A fixture-only test or a structural scan is not functional closure.
5. Record limitations, CHANGELOG, evidence snapshot, and integration registry
   entry. A missing Vivado or hardware result remains explicitly blocked.
6. Promote only when the reusable contract, independent evidence, and required
   gates are present. Otherwise retain as intake/evidence and document the
   exact missing capability; do not delete unique source or verification
   evidence.

For version bumps, update manifest and CHANGELOG first, refresh source hashes,
rerun gates, then create a new immutable `evidence/<uid>/<version>/SNAPSHOT.json`.
Older snapshots are never overwritten.

## Executable foundation-first pipeline

Use the single zero-dependency orchestrator; do not create a parallel intake
script. Every run writes `var/cbb/pipeline/<uid>/intake.json`,
`stage-ledger.json`, and command evidence. The required stage order is:

`source_scan_intake -> classification -> provenance_license -> requirements ->
normalized_rtl -> golden_reference -> reusable_sva -> randomized_verification ->
lint_gate_snapshot -> eda_certification_package -> qualification_decision ->
temporary_cleanup -> catalog_audit_update`.

From the repository root:

```text
node engineering-assets/tools/extract-cbb.cjs scan --root engineering-assets --candidate <package>
node engineering-assets/tools/extract-cbb.cjs prepare-eda --root engineering-assets --candidate <package> --update-manifest
node engineering-assets/tools/extract-cbb.cjs probe-eda --root engineering-assets --candidate <package>
node engineering-assets/tools/extract-cbb.cjs collect-eda --root engineering-assets --candidate <package> --run
node engineering-assets/tools/gate-runner.cjs engineering-assets/<package> --repo-root .
node engineering-assets/tools/evidence-snapshot.cjs <uid> --write --root engineering-assets
node engineering-assets/tools/extract-cbb.cjs run --root engineering-assets --candidate <package>
node engineering-assets/tools/maintenance-check.cjs --root engineering-assets --write
node engineering-assets/tools/maintenance-check.cjs --root engineering-assets --check
```

`extract-cbb.cjs run` is fail-closed: a pending/blocked required stage cannot
produce a qualification decision, and a qualification decision cannot claim
certified while external blockers remain. A normal rerun reads existing EDA
evidence without rewriting snapshot sources; use `collect-eda --run` only when
you intentionally create a new evidence revision.

The orchestrator uses `maintenance-check --allow-inflight` for its internal
per-candidate checks so serial runs do not self-fail on another candidate's
intermediate ledger. This flag does not relax catalog, audit, lineage, waiver,
or snapshot checks. After all candidates in a batch finish, the two unqualified
maintenance commands above must be run without `--allow-inflight`; that is the
authoritative whole-workspace handoff gate.

### EDA and cleanup boundaries

`probe-eda` records executable availability only. `collect-eda --run` records
the real ModelSim SVA runtime exit, Vivado exit, and structural CDC result. A
single-clock asset gets an explicit reviewed `na` CDC rationale plus a
structural report; multiple clocks or CDC primitives require external CDC
evidence. Missing executable, license, runtime exit, or expected artifact is
`blocked`, never `pass`.

Temporary cleanup is restricted to exact paths below `var/tmp/`, `var/build/`,
or `var/scratch/`. Source RTL/model/SVA/TB, manifests, snapshots, gate results,
and final reports are protected even if a caller lists them as removable.

### Tool/license environment discovery rule (mandatory)

Never declare a local tool or license unavailable from a bare `PATH` lookup.
Before a missing/failed conclusion, recursively scan every user-named
installation root with:

```text
node engineering-assets/tools/extract-cbb.cjs probe-eda \
  --root engineering-assets --candidate <package> \
  --install-root <user-named-install-root> \
  --vivado-root <Vivado-install-root>
```

The scanner includes hidden entries and does not filter by extension. It records
only non-secret metadata (`path`, `type`, `extension`, and file `bytes`); it
never reads or stores license contents, keys, server addresses, or credentials.
Symlinked directories are not traversed, and scan errors are
`config-discovery-failure`.

Validation must use the vendor's official launcher (for example `vsim.exe`/
Licensing Wizard or Vivado `settings64.bat` → `loader.bat`/`xlicdiag.bat`) and
an environment overlay scoped to that child process only. The supported
license variables are `LM_LICENSE_FILE`/`MGLS_LICENSE_FILE` for ModelSim and
`XILINXD_LICENSE_FILE` for Vivado. Do not use `setx`, registry edits, installer
edits, or persistent system/user environment changes. The path itself may be
recorded; its value/content must not.

Every blocked result uses exactly one evidence-led category:

1. `path-not-tested` — the user-named root was not recursively scanned; do not
   blame the environment yet.
2. `launcher-failure` — the official launcher was invoked at the discovered
   path and failed before configuration/license checkout.
3. `config-discovery-failure` — the launcher/config source or installation scan
   was missing, unreadable, or invalid.
4. `license-checkout-failure` — the tool started and explicitly rejected the
   per-process license configuration.
5. `tool-execution-failure` — launcher/config/license checks passed, but the
   requested compile/simulation/synthesis failed.

`extract-cbb.cjs` writes this policy under `G-EDA-PROBE.json`; if no
`--install-root` was supplied, unavailable-tool wording is withheld and the
status remains `path-not-tested` until the actual user-named path is exercised.

For Vivado 2023.1, `--vivado-root` triggers a complete metadata scan plus an
official-chain contract check. The required chain is
`settings64.bat` -> `bin/vivado.bat` -> `bin/loader.bat`; `bin/setupEnv.bat`,
`bin/rdiArgs.bat`, `bin/setEnvAndRunCmd.bat`, `bin/xlicdiag.bat`, and the
`bin/unwrapped/win64.o/{vivado.exe,prodversion.exe}` targets are recorded as
path/type/bytes metadata only. Never invoke those unwrapped targets directly.
The minimal verification sequence is the official `vivado.bat -version` probe,
followed by `vivado.bat -mode batch -nolog -nojournal -notrace -source
<probe.tcl>` where the Tcl prints `version -short` as
`CBB_VIVADO_VERSION_SHORT=...`. When the worker cannot write the normal user
profile, the launcher may receive per-process `APPDATA`, `LOCALAPPDATA`,
`TEMP`, `TMP`, and `PROCESSOR_ARCHITECTURE` under an exact temporary build
directory; for a 64-bit Vivado install, inherit the value or set `AMD64` in
that child process only. The official loader exits silently with code 1 when
`PROCESSOR_ARCHITECTURE` is absent, so this variable must be recorded in the
trace rather than inferred from the host shell. Pre-create only the expected
`APPDATA/Xilinx/Vivado` directory. This is reversible and must never become a
persistent profile/system change.

Vivado certification Tcl must derive `script_dir` from `[info script]` and join
source paths without `file normalize`; Vivado 2023.1 can drop hidden worktree
segments such as `.codex` during normalization. A per-process
`CBB_EDA_SCRIPT_DIR` override is allowed, and both the raw joined path and
`file exists` result belong in the trace when diagnosing path failures.

Qualification recipes use the same chain in batch mode:
`vivado.bat -mode batch -source eda/vivado_cert.tcl -tclargs <part>`. The part
must come from an existing manifest/evidence record (never guessed), and
`synth-meta.json`, `utilization.rpt`, `timing-summary.rpt`, `clocks.rpt`, and
the exit/log record are retained only when genuinely produced.

### Handoff check

Before handoff, run the two maintenance commands above and inspect
`var/audit/maintenance-report.json`. `pipeline_ledger_count`,
`pipeline_blocked_count`, `pipeline_qualification_count`, and
`historical_snapshot_count` are health metrics. A blocked candidate may remain
in intake/qualification, but malformed ledgers or a certified decision with
external blockers are RED. Historical snapshots are explicitly reported as
sealed envelopes and are not treated as current-source replay evidence.
