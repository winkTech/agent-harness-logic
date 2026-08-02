# stream_elastic_pipeline

<!-- asset-status: certified v1.0.1 -->

Reusable single-clock valid/ready elastic pipeline for opaque data words.

The package is normalized from the older `axis_pipeline_reg` and `pipe_delay`
templates. It provides `DEPTH` one-word elastic stages, ordered transfer, full
throughput when flowing, and synchronous active-high reset flush.

## Status

- Maturity: `certified` (`0.4.0`)
- Local reference model, randomized Icarus TB, and ModelSim vlog lint: passed
- SVA compile/runtime: passed with the assertion instance active; deterministic 2600-sample Golden alignment is bit-true
- Vivado 2023.1.1 synthesis/timing/utilization/checkpoint passed on `xc7a35tcpg236-1`; certified scope is generic-device verification only
- Owner signoff recorded by `lihan`; routed implementation, bitstream, board and field validation remain required for deployment

See `docs/requirements.md` and `docs/verification.md` for the contract and
evidence boundary.

<!-- BEGIN:MANIFEST:PORTS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Dir | Width | Bus |
|---|---|---:|---|
| `i_clk` | input | 1 | — |
| `i_rst` | input | 1 | — |
| `i_tdata` | input | 32 | valid-ready |
| `i_tvalid` | input | 1 | valid-ready |
| `o_tready` | output | 1 | valid-ready |
| `o_tdata` | output | 32 | valid-ready |
| `o_tvalid` | output | 1 | valid-ready |
| `i_tready` | input | 1 | valid-ready |
<!-- END:MANIFEST:PORTS -->

<!-- BEGIN:MANIFEST:PARAMS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Values | Support |
|---|---|---|
| `DATA_WIDTH` | — | yes |
| `DEPTH` | — | yes |
<!-- END:MANIFEST:PARAMS -->

<!-- BEGIN:MANIFEST:CLOCKRESET -->
<!-- Generated from manifest.json; do not edit this block. -->
| Field | Value |
|---|---|
| Clock | `i_clk` (10 ns) |
| Reset | `i_rst` / active_high / sync |
<!-- END:MANIFEST:CLOCKRESET -->
