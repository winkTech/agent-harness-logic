# Verification record

## RED

Before the normalized RTL existed, compiling `tb/tb_pulse_merge.sv` alone failed
with Icarus exit `2` (`Unknown module type: pulse_merge`).

## GREEN evidence

- `python -m unittest -v test_pulse_merge_model.py`: 3 tests passed, exit `0`.
- Icarus bounded random/reset/drain TB, `INPUT_WIDTH=4`, `COUNT_WIDTH=12`,
  seed `49374`: compile and run exit `0`.
- Icarus boundary TB, `INPUT_WIDTH=2`, `COUNT_WIDTH=4`, 300 cycles, seed `1234`:
  compile and run exit `0`.
- ModelSim `vlog -sv -lint` RTL/TB: 0 errors, 0 warnings, exit `0`.
- ModelSim `vlog -sv -lint` reusable SVA: 0 errors, 0 warnings, exit `0`.
- Official ModelSim 10.6c `vsim` with the SVA instance active: exit `0`, RTL/SVA/TB
  compile errors `0`, assertion errors `0`, deterministic driver PASS (`2600`
  samples) after the reset-boundary waiver correction.
- Golden alignment replay against `model/pulse_merge_model.py`:
  `total=2600`, `captured=2600`, `pipeline_offset=0`, `mismatch=0`,
  `bit_true=true`.
- Official Vivado 2023.1.1 batch synthesis on `xc7a35tcpg236-1`: exit `0`,
  WNS `8.101 ns`, WHS `0.148 ns`, Fmax `526.59 MHz`, LUT/FF/BRAM/DSP
  `5/5/0/0`, post-synthesis checkpoint retained.

The TB independently recomputes old-count decrement, input popcount, delayed
pulse status, reset flush, bounded overflow, and final drain.

## Governance evidence

- `node engineering-assets/tools/gate-runner.cjs cbb/pulse_merge --repo-root .`: all 20 gates pass after owner signoff; board/field validation and upstream commit pinning remain outside the gate scope.
- `node engineering-assets/tools/evidence-snapshot.cjs pulse_merge --verify
  pulse_merge@0.1.0 --root engineering-assets`: exit `0`.
- Catalog, asset-audit, integration-registry, lineage, maintenance, and redline
  checks are green for this package; the repository retains five unrelated OFDM
  vector YELLOW findings.
