#-----------------------------------------------------------------
# LDPC Simulation Script for ModelSim / Vivado Simulator
#-----------------------------------------------------------------
# Usage:
#   ModelSim: vsim -do run_sim.do
#   Vivado:   xsim --gui -tclargs run_sim.do (or use the .tcl version)
#-----------------------------------------------------------------

# 编译选项
set SIM_TIME "10 us"

# 库级约定（治理规范 §5.5）: 向量权威位置 = models/<domain>/<algo>/vectors/,
# 经 +VEC_DIR 注入; TB 内不得硬编码或用指向包外的相对路径。
# 注意: models/comm/ldpc/vectors/ 当前为空（向量从未由 MATLAB 导出），
# 解码器 TB 预期在此 fail-closed —— 向量到位前不得产出可作证据的 PASS。
set PKG {C:/Users/Lihan/.claude/engineering-assets/incubator/intake/ldpc_codec}
set VEC {C:/Users/Lihan/.claude/engineering-assets/models/comm/ldpc/vectors/}
set BUILD {C:/Users/Lihan/.claude/engineering-assets/var/build/ldpc_codec}

# 在独立 build 目录内构建, 避免 work/ transcript *.vcd 污染资产包
file mkdir $BUILD
cd $BUILD
# ModelSim 在启动时的 CWD 建 transcript；重定向到 build 目录
transcript file "$BUILD/transcript"

# 清理
if {[file exists work]} {
    vdel -all
}
vlib work

#-----------------------------------------------------------------
# 编译 RTL 源文件
#-----------------------------------------------------------------
vlog -sv -work work \
    $PKG/rtl/ldpc_defines.vh \
    $PKG/rtl/llr_buffer.v \
    $PKG/rtl/msg_buffer.v \
    $PKG/rtl/h_matrix_addr.v \
    $PKG/rtl/cn_update.v \
    $PKG/rtl/early_term.v \
    $PKG/rtl/ldpc_controller.v \
    $PKG/rtl/ldpc_decoder_top.v \
    $PKG/rtl/ldpc_encoder_top.v

#-----------------------------------------------------------------
# 选择要运行的 Testbench
#----------------------------------------------------------------=
# 解码器 TB
# vlog -sv tb_ldpc_decoder_top.v
# vsim -voptargs=+acc +VEC_DIR=$VEC work.tb_ldpc_decoder_top

# 编码器 TB
# vlog -sv tb_ldpc_encoder_top.v
# vsim -voptargs=+acc work.tb_ldpc_encoder_top

# 系统级 TB (推荐 — 全链路验证)
vlog -sv $PKG/tb/tb_ldpc_system.v
vsim -voptargs=+acc +VEC_DIR=$VEC work.tb_ldpc_system

#-----------------------------------------------------------------
# 运行
#-----------------------------------------------------------------
# 记录所有信号波形
log -r /*
run ${SIM_TIME}
quit -f
