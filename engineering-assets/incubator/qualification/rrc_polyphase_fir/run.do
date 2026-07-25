# ModelSim lint + 验证 do 脚本 — rrc_polyphase_fir 核级
# 用法: vsim -c -do run.do   (命令以 vsim 开头, 被 verification-gate 识别为功能验证)
set PKG {C:/Users/Lihan/.claude/engineering-assets/incubator/qualification/rrc_polyphase_fir}
set BUILD {C:/Users/Lihan/.claude/engineering-assets/var/build/rrc_pilot}

file mkdir $BUILD
cd $BUILD
if {[file exists work]} { vdel -all -lib work }
vlib work

echo "=========== VLOG LINT ==========="
vlog -sv -work work "$PKG/rtl/rrc_polyphase_fir.sv" "$PKG/tb/tb_rrc_polyphase_fir.sv"

echo "=========== VSIM RUN ==========="
vsim -c -quiet work.tb_rrc_polyphase_fir
run -all
quit -f
