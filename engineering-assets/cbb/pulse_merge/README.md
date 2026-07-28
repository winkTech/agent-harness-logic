# pulse_merge

<!-- asset-status: certified v0.4.0 -->

Reusable synchronous pulse-credit merger. The local implementation preserves
the behavior of the MIT vendor reference while making the interface, reset,
overflow boundary, and evidence explicit.

## Status

- Maturity: `certified` (`0.4.0`)
- Python model, Icarus bounded random/boundary TB, and ModelSim vlog lint: passed
- SVA compile/runtime: passed with the assertion instance active; deterministic 2600-sample Golden alignment is bit-true
- Provenance: MIT source and COPYING retained; upstream commit SHA is unavailable
  because the retained archive has no `.git` metadata
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
