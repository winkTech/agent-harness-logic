#==============================================================================
# sync_top 定向自检仿真 (批处理)
# 用法 (从包根目录): vsim -c -do tb/run_sim.do
# 根定位: 用 pwd 向上找包根 (勿用 [info script] — ModelSim 10.6 下解析到盘根)
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
set EVID_DIR [file join $EA var gates pg sync_top]/
file mkdir [file join $EA var gates pg sync_top stability]

set BUILD [file join $ROOT var_build]
file mkdir $BUILD
cd $BUILD

if {[file exists work]} { vdel -lib work -all }
vlib work
vmap work work

vlog -sv $ROOT/rtl/cordic_cv.sv
vlog -sv $ROOT/rtl/cordic_rot_pipe.sv
vlog -sv $ROOT/rtl/sync_detect.sv
vlog -sv $ROOT/rtl/sync_correlator.sv
vlog -sv $ROOT/rtl/sync_track_out.sv
vlog -sv $ROOT/rtl/sync_top.sv
vlog -sv $ROOT/tb/tb_sync_top.sv

vsim -c -onfinish stop work.tb_sync_top +EVID_DIR=$EVID_DIR
run -all
quit -code 0
