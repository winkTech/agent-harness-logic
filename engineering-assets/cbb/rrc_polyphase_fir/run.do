# ModelSim lint + 验证 do 脚本 — rrc_polyphase_fir 核级
# 用法（务必从 build 目录启动）:
#   cd <ROOT>/var/build/rrc_pilot && vsim -c -do <PKG>/run.do
# ModelSim 在**启动时的 CWD** 就建好 transcript 并写入, 早于脚本内的 cd 与
# `transcript file` 重定向, 二者都挡不住这个启动残桩; 从 build 目录启动才能
# 让残桩落在已 gitignore 的构建区, 而不是污染资产包。
# (命令以 vsim 开头, 被 verification-gate 识别为功能验证)
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
set PKG   "$ROOT/cbb/rrc_polyphase_fir"
set BUILD "$ROOT/var/build/rrc_pilot"
# 库级约定（治理规范 §5.5）：向量权威位置 = models/<domain>/<algo>/vectors/，
# 由 do 脚本经 +VEC_DIR 注入，TB 内不得硬编码绝对路径或指向包外的相对路径。
set VEC   "$ROOT/models/comm/rrc/vectors/"
set EVID  "$ROOT/var/gates/pg/rrc_polyphase_fir"
set RPT   "$EVID/alignment-report.json"
file mkdir $EVID
file mkdir $EVID/stability

file mkdir $BUILD
set LAUNCH [pwd]
cd $BUILD
# ModelSim 在**启动时的 CWD** 就已建好 transcript 并写入若干行，早于本脚本执行；
# 故重定向只能挡住后半段，启动残桩需在收尾时清理（见文件末尾）。
transcript file "$BUILD/transcript"
if {[file exists work]} { vdel -all -lib work }
vlib work

echo "=========== VLOG LINT ==========="
vlog -sv -work work "$PKG/rtl/rrc_polyphase_fir.sv" "$PKG/tb/tb_rrc_polyphase_fir.sv"

echo "=========== VSIM RUN ==========="
vsim -c -quiet +VEC_DIR=$VEC +RPT_F=$RPT +EVID_DIR=$EVID/ work.tb_rrc_polyphase_fir
run -all
quit -f
