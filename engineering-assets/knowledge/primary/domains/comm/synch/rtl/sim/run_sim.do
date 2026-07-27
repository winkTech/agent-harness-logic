#==============================================================================
# ModelSim/Questa Simulation Script for OFDM Synchronization
#==============================================================================
if {[file exists work]} { vdel -all }
vlib work
vmap work work

# Compile RTL
vlog -sv +incdir+../src ../src/sync_pkg.sv
vlog -sv +incdir+../src ../src/cordic_core.sv
vlog -sv +incdir+../src ../src/packet_detect.sv
vlog -sv +incdir+../src ../src/fine_timing.sv
vlog -sv +incdir+../src ../src/sync_top.sv

# Testbench
vlog -sv tb_sync_top.sv

# Simulate
vsim -voptargs=+acc work.tb_sync_top

add wave -divider "Top"
add wave sim:/tb_sync_top/dut/*
add wave -divider "Packet Detect"
add wave sim:/tb_sync_top/dut/u_pd/*
add wave -divider "Fine Timing"
add wave sim:/tb_sync_top/dut/u_ft/*

run 50000 ns
