#==============================================================================
# RRC 成形滤波器 — ModelSim/Questa Simulation Script
# Usage: vsim -do run_sim.do
#==============================================================================

# Compile source files
set SRC_DIR "../src"
set SIM_DIR "."

# Clear previous run
run_sim.do_clear

# Compile design files
vlog -sv -work work +incdir+$SRC_DIR $SRC_DIR/rrc_polyphase_fir.sv
vlog -sv -work work +incdir+$SRC_DIR $SRC_DIR/rrc_top.sv

# Compile testbench
vlog -sv -work work tb_rrc_top.sv

# Optimize and load
vsim -voptargs=+acc work.tb_rrc_top

# Add waves
add wave -position insertpoint sim:/tb_rrc_top/*
add wave -position insertpoint sim:/tb_rrc_top/u_dut/u_fir/*

# Run simulation
run 50000 ns

# Report
if { [find signals -r /tb_rrc_top/err_count] == 0 } {
    echo "PASS: No errors"
} else {
    echo "FAIL: Errors detected"
}

# View waveform
wave zoom full
