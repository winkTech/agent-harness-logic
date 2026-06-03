#==============================================================================
# ModelSim/Questa Simulation Script for Channel Estimation
# Usage: vsim -do run_sim.do
#==============================================================================

# Clean
if {[file exists work]} { vdel -all }

# Create work library
vlib work
vmap work work

# Compile RTL
vlog -sv +incdir+../src ../src/ls_estimator.sv
vlog -sv +incdir+../src ../src/channel_interpolator.sv
vlog -sv +incdir+../src ../src/channel_est_top.sv

# Compile testbench
vlog -sv tb_channel_est_top.sv

# Load and run
vsim -voptargs=+acc work.tb_channel_est

# Add waves
add wave -divider "Top Level"
add wave sim:/tb_channel_est/dut/*
add wave -divider "LS Estimator"
add wave sim:/tb_channel_est/dut/u_ls_estimator/*
add wave -divider "Interpolator"
add wave sim:/tb_channel_est/dut/u_interpolator/*

# Run
run 50000 ns

# Done
