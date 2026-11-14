# pulse_merge

<!-- asset-status: certified v1.0.2 -->

Reusable synchronous pulse-credit merger. The local implementation preserves
the behavior of the MIT vendor reference while making the interface, reset,
overflow boundary, and evidence explicit.

## Status

- Maturity: `certified` (`0.4.0`)
- Python model, Icarus bounded random/boundary TB, and ModelSim vlog lint: passed
- SVA compile/runtime: passed with the assertion instance active; deterministic 2600-sample Golden alignment is bit-true
- Provenance: MIT source and COPYING retained; upstream commit **pinned** to
  [`25156a9a`](https://github.com/alexforencich/verilog-pcie/commit/25156a9a162c41c60f11f41590c7d006d015ae5a)
  (2024-04-26, "Add example design for Alveo U55C"). This corrects the 0.4.0 note that
  said the SHA "is unavailable because the retained archive has no `.git` metadata" —
  missing `.git` only loses the metadata, while git blob SHAs are a function of content,
  so the commit is recoverable by content matching. Evidence: all 633 archive paths
  matched the upstream tree with **0 unexplained blob differences**
  (4 byte-identical, 545 CRLF-only, 84 upstream symlinks that Windows ZIP extraction
  wrote as empty files — the upstream symlink count is exactly 84). The file this CBB
  derives from, `rtl/pulse_merge.v`, matches upstream blob `aafe38a8` once line endings
  are normalized. See `manifest.json` → `provenance.commit_basis`.
- Vivado 2023.1.1 synthesis/timing/utilization/checkpoint passed on `xc7a35tcpg236-1`; certified scope is generic-device verification only
- Owner signoff recorded by `lihan`; routed implementation, bitstream, board and field validation remain required for deployment

See `docs/requirements.md` and `docs/verification.md` for exact semantics.

<!-- BEGIN:MANIFEST:PORTS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Dir | Width | Bus |
|---|---|---:|---|
| `i_clk` | input | 1 | — |
| `i_rst` | input | 1 | — |
| `i_pulse_in` | input | 4 | — |
| `o_count_out` | output | 12 | — |
| `o_pulse_out` | output | 1 | — |
<!-- END:MANIFEST:PORTS -->

<!-- BEGIN:MANIFEST:PARAMS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Values | Support |
|---|---|---|
| `INPUT_WIDTH` | — | yes |
| `COUNT_WIDTH` | — | yes |
<!-- END:MANIFEST:PARAMS -->

<!-- BEGIN:MANIFEST:CLOCKRESET -->
<!-- Generated from manifest.json; do not edit this block. -->
| Field | Value |
|---|---|
| Clock | `i_clk` (10 ns) |
| Reset | `i_rst` / active_high / sync |
<!-- END:MANIFEST:CLOCKRESET -->
