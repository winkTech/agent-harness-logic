# External EDA certification package: pulse_merge@0.4.0

This package is deterministic and fail-closed. It is a recipe and artifact contract, not evidence of execution.

## Commands
- Probe: `node engineering-assets/tools/extract-cbb.cjs probe-eda --root engineering-assets --candidate <package>`.
- ModelSim SVA: from the package/evidence working directory run `vsim -c -do <package>/eda/modelsim_sva.do`; retain exit code and `G-SVA-RUNTIME.json`.
- Vivado: from the package/evidence working directory run `vivado -mode batch -source <package>/eda/vivado_cert.tcl -tclargs <part>`; retain `synth-meta.json`, timing/utilization/clocks artifacts.
- CDC: retain `cdc-report.json`; the current structural result is explicit NA only when one clock and no CDC primitive are present.

Missing executable, license, runtime exit, or expected artifact is `blocked`; never convert it to pass.
