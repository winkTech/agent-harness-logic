# Verification record

## RED

Before the RTL existed, compiling `tb/tb_stream_elastic_pipeline.sv` alone
failed with Icarus exit `2` and `Unknown module type: stream_elastic_pipeline`.
This is retained as the TDD RED observation; no source artifact was generated.

## GREEN evidence

- `python -m unittest -v test_stream_elastic_pipeline_model.py`: 4 tests passed,
  exit `0`.
- `iverilog -g2012` plus `vvp` randomized TB: `DEPTH=1`, `DEPTH=2`, and
  `DEPTH=4`, each compile exit `0` and run exit `0`; fixed seeds `1001`, `1002`,
  and `1004`; 1200 randomized cycles plus drain.
- `vlog -sv -lint` on RTL and TB: 0 errors, 0 warnings, exit `0`.
- `vlog -sv -lint` on reusable SVA: 0 errors, 0 warnings, exit `0`.
- Official ModelSim 10.6c `vsim` with the SVA instance active: exit `0`, RTL/SVA/TB
  compile errors `0`, assertion errors `0`, deterministic driver PASS (`2600`
  samples).
- Golden alignment replay against `model/stream_elastic_pipeline_model.py`:
  `total=2600`, `captured=2600`, `input_transfers=1020`,
  `output_transfers=983`, fixed `pipeline_offset=4`, `mismatch=0`,
  `bit_true=true`.
- Official Vivado 2023.1.1 batch synthesis on `xc7a35tcpg236-1`: exit `0`,
  WNS `7.554 ns`, WHS `0.154 ns`, Fmax `408.83 MHz`, LUT/FF/BRAM/DSP
  `4/66/0/0`, post-synthesis checkpoint retained.

The TB uses an independent bounded queue to check accepted/output ordering,
stall stability, reset flush, simultaneous movement, and drain. It does not use
the DUT to generate its expected data.

## Governance evidence

- `node engineering-assets/tools/gate-runner.cjs cbb/stream_elastic_pipeline --repo-root .`: all 20 gates pass after owner signoff; board/field validation remains outside the gate scope.
- `node engineering-assets/tools/evidence-snapshot.cjs stream_elastic_pipeline
  --verify stream_elastic_pipeline@0.1.0 --root engineering-assets`: exit `0`.
- Catalog, asset-audit, integration-registry, lineage, maintenance, and redline
  checks are green for this package; the repository retains five unrelated OFDM
  vector YELLOW findings.
