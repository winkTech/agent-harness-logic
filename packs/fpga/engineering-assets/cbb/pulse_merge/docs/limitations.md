# Limitations and verification boundaries

- The implementation preserves the reference modulo counter behavior; callers
  must bound pulse traffic so the next count remains representable.
- `o_pulse_out` reports the previous registered count status, not the current
  same-edge popcount result.
- No CDC, handshake, saturation, packet sideband, Vivado timing/resource,
  board, or hardware evidence is included.
- ModelSim 10.6c SVA runtime and deterministic Golden alignment are proven for
  the recorded 2600-sample configuration; other parameter values require a new
  run.
- Vivado synthesis/timing/utilization/CDC structural evidence is for the generic
  `xc7a35tcpg236-1` target only. Routed implementation, bitstream, and board
  validation remain outside this package and are not implied by certification.
- Upstream provenance is MIT and retained, but commit SHA is unavailable in the
  archived ZIP; reproducible upstream checkout is an explicit open boundary.
