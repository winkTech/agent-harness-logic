# ModelSim lint + 验证 do 脚本 — ofdm_tx_top
# 用法: vsim -c -do run.do   (命令以 vsim 开头, 被 verification-gate 识别为功能验证)
#
# 库级约定（治理规范 §5.5）: 向量权威位置 = models/<domain>/<algo>/vectors/,
# 由本脚本经 +VEC_DIR 注入; TB 内不得硬编码绝对路径或指向包外的相对路径。

set ROOT  {C:/Users/Lihan/.claude/engineering-assets}
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
