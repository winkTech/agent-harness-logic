# ModelSim 验证 do 脚本 — channel_est_top
# 用法（务必从 build 目录启动，否则 ModelSim 的启动残桩会落进资产包）:
#   cd <ROOT>/var/build/<uid> && vsim -c -do <PKG>/run.do
#
# 库级约定（治理规范 §5.5）: 向量权威位置 = models/<domain>/<algo>/vectors/,
# 由本脚本经 +VEC_DIR 注入; TB 内不得硬编码绝对路径或指向包外的相对路径。
#
# 注意: models/comm/channel_est/vectors/ 当前为空（向量从未由 MATLAB 导出），
# 因此本脚本预期在 TB 的 fail-closed 处终止。这是正确行为 —— 在向量到位前
# 本包不得产出任何可作为门禁证据的 PASS。

# ROOT 自定位（脱敏：不硬编码本机路径）
# 优先 EA_ROOT 环境变量；否则从本脚本位置向上找到 engineering-assets 目录。
if {[info exists ::env(EA_ROOT)]} {
  set ROOT $::env(EA_ROOT)
} else {
  set ROOT [file dirname [file normalize [info script]]]
  while {[file tail $ROOT] ne "engineering-assets" && $ROOT ne [file dirname $ROOT]} {
    set ROOT [file dirname $ROOT]
  }
}
set PKG   "$ROOT/incubator/intake/channel_est_top"
set BUILD "$ROOT/var/build/channel_est_top"
set VEC   "$ROOT/models/comm/channel_est/vectors/"
set EVID  "$ROOT/var/gates/pg/channel_est_top"

file mkdir $BUILD
file mkdir $EVID
cd $BUILD
# ModelSim 在启动时的 CWD 建 transcript；重定向到 build 目录，避免污染资产包
transcript file "$BUILD/transcript"
if {[file exists work]} { vdel -all -lib work }
vlib work

echo "=========== VLOG LINT ==========="
vlog -sv -work work \
    "$PKG/rtl/ls_estimator.sv" \
    "$PKG/rtl/channel_interpolator.sv" \
    "$PKG/rtl/channel_est_top.sv" \
    "$PKG/tb/tb_chEst_cosim.sv"

echo "=========== VSIM RUN ==========="
vsim -c -quiet +VEC_DIR=$VEC work.tb_chEst_cosim
run -all
quit -f
