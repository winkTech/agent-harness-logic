# stream_elastic_pipeline requirements

<!-- asset-status: certified v0.4.0 -->

## Scope

`stream_elastic_pipeline` is a reusable single-clock valid/ready elastic pipeline
for opaque words. It is normalized from the existing `axis_pipeline_reg` and
`pipe_delay` templates; it does not carry packet sidebands and does not cross
clock domains.

## Contract

- Parameters: `DATA_WIDTH >= 1`, `DEPTH >= 1`.
- Clock/reset: `i_clk` is the only clock. `i_rst` is a synchronous active-high
  reset sampled on `posedge i_clk`.
- Ports: `i_tdata`, `i_tvalid`, `o_tready`, `o_tdata`, `o_tvalid`, `i_tready`.
- An input transaction is accepted only on `i_tvalid && o_tready` at a rising
  edge. An output transaction is transferred only on `o_tvalid && i_tready`.
- Every accepted input produces exactly one output transaction, in order, unless
  a synchronous reset flushes it before transfer. No transaction is duplicated,
  lost, or reordered.
- While `o_tvalid && !i_tready`, `o_tvalid` and `o_tdata` remain stable until
  transfer or reset.
- The pipeline has `DEPTH` one-word storage slots, accepts and emits one word per
  cycle when full and flowing, and propagates backpressure to `o_tready`.
- A reset clears occupancy. Outputs may be observed as zero after the reset edge;
  no pre-reset word may appear after reset.

## Qualification criteria

1. The independent Python model passes basic, stall, reset, boundary, and random
   scenarios.
2. The RTL TB passes fixed-seed randomized backpressure/reset scenarios for
   `DEPTH=1,2,4` and checks queue order, stability, flush, and drain.
3. Reusable SVA properties compile in a simulator with SVA support and are
   instantiated by the TB or bind file.
4. Icarus/ModelSim lint is clean for RTL and TB sources; no implicit nets or
   unbounded generated outputs are used.
5. Manifest/schema, documentation, lifecycle, and gate evidence are present.
6. Certified scope records generic-device synthesis/timing/CDC evidence on
   `xc7a35tcpg236-1`; routed implementation, bitstream and board/field closure
   remain outside this admission.
