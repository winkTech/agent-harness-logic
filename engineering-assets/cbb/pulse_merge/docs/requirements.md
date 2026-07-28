# pulse_merge requirements

<!-- asset-status: certified v0.4.0 -->

`pulse_merge` combines several single-cycle status pulses into a registered
pending-credit counter. This is a local normalized implementation based on the
MIT-licensed vendor reference at
`engineering-assets/reference-assets/vendor/verilog-pcie-master/rtl/pulse_merge.v`.

## Contract

- Parameters: `INPUT_WIDTH >= 1`, `COUNT_WIDTH >= 1`.
- Clock/reset: only `i_clk`; `i_rst` is synchronous active-high.
- On each non-reset rising edge, let `old_count` be the previous registered
  count and `p = popcount(i_pulse_in)`. The next count is
  `max(old_count-1, 0) + p`, represented modulo `2**COUNT_WIDTH` exactly as the
  vendor reference. Qualification vectors must keep this value below the
  representable maximum; unbounded-rate overflow is outside the contract.
- `o_count_out` is the registered next count after the edge.
- `o_pulse_out` is the registered status of `old_count != 0`; therefore it is a
  one-edge delayed indication of pending credits, matching the vendor source.
- Reset clears both outputs and all pending credits. No pre-reset credit may
  reappear after reset.
- There is no CDC, handshake, packet sideband, or saturation guarantee.

## Qualification criteria

1. Independent Python credit model passes basic, burst, reset, and bounded random
   scenarios.
2. RTL TB independently recomputes popcount/count/pulse behavior and passes
   fixed-seed bounded random vectors plus drain.
3. Reusable reset/count-latency SVA compiles in an SVA-capable simulator.
4. RTL/TB lint has zero errors/warnings and no implicit nets/initial blocks.
5. MIT COPYING and provenance are retained. The upstream archive has no commit
   SHA; this remains an explicit reproducibility boundary.
6. Certified scope records generic-device synthesis/timing/CDC evidence on
   `xc7a35tcpg236-1`; routed implementation, bitstream and board/field closure
   remain outside this admission.
