# Limitations and verification boundaries

- The module has no packet sideband (`last`, `keep`, `id`, `user`) and no CDC
  behavior. It is not an AXI packet formatter or clock-domain bridge.
- `DATA_WIDTH` and `DEPTH` are required to be at least one; unsupported values
  are outside the package contract.
- Icarus randomized regressions cover `DEPTH=1,2,4`; other parameter values need
  a new qualification run.
- ModelSim 10.6c SVA runtime and deterministic Golden alignment are proven for
  the recorded 2600-sample configuration; other parameter values require a new
  run.
- Vivado synthesis/timing/utilization/CDC structural evidence is for the generic
  `xc7a35tcpg236-1` target only. Routed implementation, bitstream, and board
  validation remain outside this package and are not implied by certification.
