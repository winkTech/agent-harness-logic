# ModelSim/Questa 仿真脚本
# 用法: vsim -do run_sim.do

# 编译
vlib work

# 编译源文件
vlog -sv ../rtl/src/ofdm_tx_top.sv
vlog -sv ../rtl/src/mapper.sv
vlog -sv ../rtl/src/pilot_insert.sv
vlog -sv ../rtl/src/cp_insert.sv
vlog -sv tb_tx_top.sv

# 启动仿真
vsim -voptargs="+acc" work.tb_ofdm_tx_top

# 添加波形
add wave -hex /tb_ofdm_tx_top/dut/*
add wave -hex /tb_ofdm_tx_top/*

# 运行
run -all

# 查看结果
view wave
