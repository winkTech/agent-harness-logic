#==============================================================================
# channel_est_top 帧级 cosim (bit-true, G-B-03 证据)
# 用法 (从包根目录): vsim -c -do tb/run_cosim.do
# 前置: MATLAB 已跑 generate_vectors(struct('nsym',32)) 导出帧向量
# 根定位: pwd 向上找包根; 再向上找 engineering-assets 求库根
#==============================================================================
onerror {quit -code 1}

set ROOT [pwd]
while {![file exists [file join $ROOT manifest.json]]} {
    set parent [file dirname $ROOT]
    if {$parent eq $ROOT} { puts "FATAL: 找不到包根 (manifest.json)"; quit -code 1 }
    set ROOT $parent
}
set EA $ROOT
while {[file tail $EA] ne "engineering-assets"} {
    set parent [file dirname $EA]
    if {$parent eq $EA} { puts "FATAL: 找不到 engineering-assets 根"; quit -code 1 }
    set EA $parent
}
set VEC_DIR  [file join $EA models comm channel_est vectors]/
set EVID_DIR [file join $EA var gates pg channel_est_top]/
file mkdir [file join $EA var gates pg channel_est_top]

set BUILD [file join $ROOT var_build]
file mkdir $BUILD
cd $BUILD

if {[file exists work]} { vdel -lib work -all }
vlib work
vmap work work

vlog -sv $ROOT/rtl/cordic_cv.sv
vlog -sv $ROOT/rtl/lts_estimator.sv
vlog -sv $ROOT/rtl/cpe_rotate_out.sv
vlog -sv $ROOT/rtl/cpe_tracker.sv
vlog -sv $ROOT/rtl/channel_est_top.sv
vlog -sv $ROOT/tb/tb_chEst_cosim.sv

vsim -c -onfinish stop work.tb_chEst_cosim +VEC_DIR=$VEC_DIR +EVID_DIR=$EVID_DIR
run -all
quit -code 0
