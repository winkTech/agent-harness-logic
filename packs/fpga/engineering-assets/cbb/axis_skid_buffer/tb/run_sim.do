#-----------------------------------------------------------------
# axis_skid_buffer — 自检 TB 运行脚本 (ModelSim / Questa)
# 用法 (任意 cwd):  vsim -c -do <path>/run_sim.do
# 或先设 EA_ROOT:   EA_ROOT=<engineering-assets> vsim -c -do run_sim.do
# 产出: var/gates/pg/axis_skid_buffer/ 下的 tb-selfcheck.json /
#       reset-sim.json / stability/*.json (仅 TB 全绿时写入)
#-----------------------------------------------------------------

if {[info exists ::env(EA_ROOT)]} {
  set ROOT $::env(EA_ROOT)
} else {
  # 以 cwd 为基准走査 (调用约定: cd 到本 tb 目录再 vsim -do run_sim.do)。
  # 不用 [info script]: ModelSim 10.6 在 do 里对相对路径 normalize 会解析到盘根。
  set ROOT [pwd]
  while {[file tail $ROOT] ne "engineering-assets" && $ROOT ne [file dirname $ROOT]} {
    set ROOT [file dirname $ROOT]
  }
  if {[file tail $ROOT] ne "engineering-assets"} {
    puts "ERROR: cannot locate engineering-assets root from [pwd]; set EA_ROOT"
    quit -code 2 -f
  }
}
set PKG   "$ROOT/cbb/axis_skid_buffer"
set EVID  "$ROOT/var/gates/pg/axis_skid_buffer"
set BUILD "$ROOT/var/build/axis_skid_buffer"
file mkdir $BUILD
file mkdir $EVID
file mkdir "$EVID/stability"
cd $BUILD
transcript file "$BUILD/transcript"

if {[file exists work]} { vdel -all }
vlib work

vlog -sv -work work $PKG/rtl/axis_skid_buffer.sv $PKG/tb/tb_axis_skid_buffer.sv

vsim -c -onfinish stop work.tb_axis_skid_buffer +EVID_DIR=$EVID
onerror {quit -code 1 -f}
run -all
quit -f
