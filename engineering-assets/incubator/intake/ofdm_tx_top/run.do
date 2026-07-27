# ModelSim lint + 验证 do 脚本 — ofdm_tx_top
# 用法（务必从 build 目录启动，否则 ModelSim 的启动残桩会落进资产包）:
#   cd <ROOT>/var/build/ofdm_tx_top && vsim -c -do <PKG>/run.do
#
# 库级约定（治理规范 §5.5）: 向量权威位置 = models/<domain>/<algo>/vectors/,
# 由本脚本经 +VEC_DIR 注入; TB 内不得硬编码绝对路径或指向包外的相对路径。

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
set PKG   "$ROOT/incubator/intake/ofdm_tx_top"
set BUILD "$ROOT/var/build/ofdm_tx_top"
set VEC   "$ROOT/models/comm/ofdm/vectors/"
set EVID  "$ROOT/var/gates/pg/ofdm_tx_top"

file mkdir $BUILD
file mkdir $EVID
cd $BUILD
# ModelSim 在启动时的 CWD 建 transcript；重定向到 build 目录，避免污染资产包
transcript file "$BUILD/transcript"
if {[file exists work]} { vdel -all -lib work }
vlib work

echo "=========== VLOG LINT ==========="
vlog -sv -work work \
    "$PKG/rtl/mod_mapper.sv" \
    "$PKG/rtl/mapper.sv" \
    "$PKG/rtl/pilot_insert.sv" \
    "$PKG/rtl/xfft_64.sv" \
    "$PKG/rtl/cp_insert.sv" \
    "$PKG/rtl/ofdm_tx_top.sv" \
    "$PKG/tb/tb_tx_top.sv"

echo "=========== VSIM RUN ==========="
vsim -c -quiet +VEC_DIR=$VEC work.tb_ofdm_tx_top
run -all
quit -f
