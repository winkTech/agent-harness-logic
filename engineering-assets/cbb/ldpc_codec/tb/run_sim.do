#-----------------------------------------------------------------
# LDPC Simulation Script for ModelSim / Questa
#-----------------------------------------------------------------
# Usage (from any cwd):
#   vsim -do engineering-assets/incubator/intake/ldpc_codec/tb/run_sim.do
# Or set EA_ROOT then: vsim -do run_sim.do
#-----------------------------------------------------------------

set SIM_TIME "2 ms"

# ROOT = engineering-assets (via EA_ROOT or walk-up from this script)
if {[info exists ::env(EA_ROOT)]} {
  set ROOT $::env(EA_ROOT)
} else {
  set ROOT [file dirname [file normalize [info script]]]
  while {[file tail $ROOT] ne "engineering-assets" && $ROOT ne [file dirname $ROOT]} {
    set ROOT [file dirname $ROOT]
  }
}
set PKG   "$ROOT/incubator/intake/ldpc_codec"
set VEC   "$ROOT/models/comm/ldpc/vectors"
set PT    "$PKG/rtl/pt_columns.hex"
set BUILD "$ROOT/var/build/ldpc_codec"
file mkdir $BUILD
cd $BUILD
transcript file "$BUILD/transcript"

# encoder 的 PT ROM 用 $readmemb 相对路径读 (综合友好, 见 ldpc_encoder_top 头注释),
# 仿真 CWD 是 $BUILD —— 必须把 hex 拷到位, 否则 pt_rom 全 X, 非零帧校验位全错
file copy -force $PT $BUILD/pt_columns.hex

if {[file exists work]} { vdel -all }
vlib work

#-----------------------------------------------------------------
# RTL
#-----------------------------------------------------------------
vlog -sv -work work +incdir+$PKG/rtl \
    $PKG/rtl/ldpc_defines.vh \
    $PKG/rtl/llr_buffer.v \
    $PKG/rtl/msg_buffer.v \
    $PKG/rtl/h_matrix_addr.v \
    $PKG/rtl/cn_update.v \
    $PKG/rtl/early_term.v \
    $PKG/rtl/ldpc_controller.v \
    $PKG/rtl/ldpc_stream_io.v \
    $PKG/rtl/ldpc_decoder_top.v \
    $PKG/rtl/ldpc_encoder_top.v

#-----------------------------------------------------------------
# Choose ONE testbench (uncomment)
#-----------------------------------------------------------------

# --- Decoder bit-true (10 vectors) ---
# vlog -sv -work work $PKG/tb/tb_ldpc_decoder_top.v
# vsim -c -voptargs=+acc work.tb_ldpc_decoder_top \
#     +VEC_DIR=$VEC +EVID_DIR=$ROOT/var/gates/pg/ldpc_codec
# run -all
# quit -f

# --- Encoder bit-true (5 vectors, PT ROM) ---
vlog -sv -work work $PKG/tb/tb_ldpc_encoder_top.v
vsim -c -voptargs=+acc work.tb_ldpc_encoder_top \
    +VEC_DIR=$VEC +PT_MEM=$PT
run -all
quit -f

# --- System (encoder+decoder) ---
# vlog -sv -work work $PKG/tb/tb_ldpc_system.v
# vsim -c -voptargs=+acc work.tb_ldpc_system +VEC_DIR=$VEC +PT_MEM=$PT
# run -all
# quit -f
