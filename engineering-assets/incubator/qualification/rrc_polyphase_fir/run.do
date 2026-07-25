# ModelSim lint + 验证 do 脚本 — rrc_polyphase_fir 核级
# 用法: vsim -c -do run.do   (命令以 vsim 开头, 被 verification-gate 识别为功能验证)
set ROOT  {C:/Users/Lihan/.claude/engineering-assets}
set PKG   "$ROOT/incubator/qualification/rrc_polyphase_fir"
set BUILD "$ROOT/var/build/rrc_pilot"
# 库级约定（治理规范 §5.5）：向量权威位置 = models/<domain>/<algo>/vectors/，
# 由 do 脚本经 +VEC_DIR 注入，TB 内不得硬编码绝对路径或指向包外的相对路径。
set VEC   "$ROOT/models/comm/rrc/vectors/"
set EVID  "$ROOT/var/gates/pg/rrc_polyphase_fir"
set RPT   "$EVID/alignment-report.json"
file mkdir $EVID

file mkdir $BUILD
cd $BUILD
# ModelSim 在启动时的 CWD 建 transcript；重定向到 build 目录，避免污染资产包
transcript file "$BUILD/transcript"
if {[file exists work]} { vdel -all -lib work }
vlib work

echo "=========== VLOG LINT ==========="
vlog -sv -work work "$PKG/rtl/rrc_polyphase_fir.sv" "$PKG/tb/tb_rrc_polyphase_fir.sv"

echo "=========== VSIM RUN ==========="
vsim -c -quiet +VEC_DIR=$VEC +RPT_F=$RPT work.tb_rrc_polyphase_fir
run -all
quit -f
