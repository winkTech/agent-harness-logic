#==============================================================================
# ModelSim/Questa Simulation Script for OFDM Synchronization
#==============================================================================
# 库级约定（治理规范 §5.5）：本包 TB 使用**内部自生成激励**（短/长前导 + CFO 旋转），
# 不读外部向量文件，故 +VEC_DIR 标 na —— 这是 V-1 的合法例外，须在此显式记录。
# 但 tb_sync_top 的判据是布尔 packet_detected 标志：若信号为 X，if 条件求值为假
# 而计入 error_cnt，方向是 fail-safe，不会产生假绿。
# 待 golden 导出同步链向量后，应改为对 golden 的逐样点比对并适用 V-2..V-6。
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
