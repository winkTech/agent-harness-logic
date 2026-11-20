#-----------------------------------------------------------------
# LDPC Simulation Script for ModelSim / Vivado Simulator
#-----------------------------------------------------------------
# Usage:
#   ModelSim: vsim -do run_sim.do
#   Vivado:   xsim --gui -tclargs run_sim.do (or use the .tcl version)
#-----------------------------------------------------------------

# 编译选项
set SIM_TIME "10 us"

# 清理
if {[file exists work]} {
    vdel -all
}
vlib work

#-----------------------------------------------------------------
# 编译 RTL 源文件
#-----------------------------------------------------------------
vlog -sv -work work \
    ../01_rtl/ldpc_defines.vh \
    ../01_rtl/llr_buffer.v \
    ../01_rtl/msg_buffer.v \
    ../01_rtl/h_matrix_addr.v \
    ../01_rtl/cn_update.v \
    ../01_rtl/early_term.v \
    ../01_rtl/ldpc_controller.v \
    ../01_rtl/ldpc_decoder_top.v \
    ../01_rtl/ldpc_encoder_top.v

#-----------------------------------------------------------------
# 选择要运行的 Testbench
#----------------------------------------------------------------=
# 解码器 TB
# vlog -sv tb_ldpc_decoder_top.v
# vsim -voptargs=+acc work.tb_ldpc_decoder_top

# 编码器 TB
# vlog -sv tb_ldpc_encoder_top.v
# vsim -voptargs=+acc work.tb_ldpc_encoder_top

# 系统级 TB (推荐 — 全链路验证)
vlog -sv tb_ldpc_system.v
vsim -voptargs=+acc work.tb_ldpc_system

#-----------------------------------------------------------------
# 运行
#-----------------------------------------------------------------
log -r /*       # 记录所有信号波形
run ${SIM_TIME}
quit -f
