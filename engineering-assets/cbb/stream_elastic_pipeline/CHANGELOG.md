# Changelog

## [1.0.0] - 2026-08-02

**纯版本号转正**（owner 2026-08-02 裁定）。RTL、约束、TB、证据与全部功能结论
自 0.4.0 起未做任何改动。

资产自 2026-07-27 起就是 certified，但版本号一直停在 0.4.0，与库内其余 certified
资产不一致 —— 引用方按版本号推断成熟度会读错。`evidence_ref` /
`evidence_snapshot_ref` 指向 `evidence/stream_elastic_pipeline/1.0.0/`，
0.4.0 快照原封转为历史。

`board-validation` 仍未还清（需实际硬件）。

## [0.4.0] - 2026-07-27

- Owner signoff completed and the foundation asset was admitted to `cbb/` with bit-true, ModelSim, Vivado and CDC evidence; board/field validation remains outside the release scope.

## [0.3.8] - 2026-07-27

- Added real ModelSim 10.6c assertion-instance execution and 2600-sample bit-true Golden alignment (mismatch=0).

## [0.3.7] - 2026-07-26

- Recorded real Vivado 2023.1.1 synthesis, utilization, timing, clocks, and post-synthesis checkpoint evidence for `xc7a35tcpg236-1`; certified promotion remains blocked by bit-true/signoff gates.

## [0.3.6] - 2026-07-26

- Sealed the refreshed manifest hashes after recipe generation; 0.3.5 remains an immutable historical evidence envelope.

## [0.3.5] - 2026-07-26

- Refreshed manifest source hashes after the deterministic EDA recipe update; 0.3.4 remains an immutable historical evidence envelope.

## [0.3.4] - 2026-07-26

- Fixed official Vivado batch launch for workers missing `PROCESSOR_ARCHITECTURE` and preserved hidden `.codex` worktree paths in the certification Tcl recipe. ModelSim SVA is green; Vivado synthesis remains blocked by the genuine device-license checkout result.

## [0.3.3] - 2026-07-26

- Kept ModelSim work libraries in the temporary EDA build root and added the
  Vivado-generated `synth-meta.json` artifact contract.

## [0.3.2] - 2026-07-26

- Hardened external EDA scripts to resolve package paths from the script
  location and removed the invalid Vivado self-as-XDC read.

## [0.3.1] - 2026-07-26

- Reissued the qualification snapshot after real EDA collection; the prior
  0.3.0 snapshot remains immutable historical evidence.

## [0.3.0] - 2026-07-26

- Added 100 MHz create_clock constraint, resource budget envelope, and local
  reset/stability evidence for the certification gates.
- External timing/utilization, bit-true cosim, and signoff remain blocked until
  genuine EDA execution is available.

## [0.2.0] - 2026-07-26

- Added deterministic extraction-pipeline intake/provenance and external EDA
  certification recipes with fail-closed ModelSim/Vivado/CDC evidence.
- Retained immutable 0.1.0 evidence; 0.2.0 records the real ModelSim license
  exit 4 and missing Vivado probe without a certified claim.

## [0.1.0] - 2026-07-26

- Added normalized `stream_elastic_pipeline` RTL with `DATA_WIDTH` and `DEPTH`.
- Added independent Python queue reference model and unit tests.
- Added reusable valid/ready SVA properties and randomized reset/backpressure TB.
- Qualified local compile/simulation paths; retained EDA/runtime boundaries.
