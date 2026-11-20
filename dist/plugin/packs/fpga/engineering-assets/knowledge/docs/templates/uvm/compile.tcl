# ============================================================================
# Vivado xsim 编译运行脚本 (UVM 1.2)
# 用法: vivado -mode batch -source compile.tcl
#   或: source compile.tcl   (在 Vivado xsim shell 中)
#   或: xsim tb_ofdm_uvm_top --runall
#
# 注意事项:
#   - xvlog 需要 --define UVM_NO_DPI 等宏来匹配 Vivado 预编译库
#   - xelab 需要 -timescale 1ns/1ps
#   - run_test() 必须在 0 时刻调用 (不能有 #100 延迟)
# ============================================================================

set UVM_VER 1.2
set PRJ_DIR [file dirname [file normalize [info script]]]
set SRC_DIR [file join $PRJ_DIR "../../../knowledge/primary/domains/comm/ofdm/rtl/src"]
set UVM_SRC "C:/Xilinx/Vivado/2023.1/data/system_verilog/uvm_1.2/xlnx_uvm_package.sv"

# UVM NO-DPI defines (匹配 Vivado 预编译库)
set UVM_DEFINES "--define UVM_NO_DPI --define UVM_CMDLINE_NO_DPI --define UVM_HDL_NO_DPI --define UVM_REGEX_NO_DPI"

puts "================================================================="
puts " Compiling OFDM UVM Testbench"
puts " UVM version : $UVM_VER"
puts " Source      : $SRC_DIR"
puts "================================================================="

# 1. Vivado UVM 包 (带 NO-DPI 宏)
xvlog --nolog -sv $UVM_DEFINES $UVM_SRC

# 2. 接口
xvlog --nolog -sv [file join $PRJ_DIR reset_if.sv]
xvlog --nolog -sv [file join $PRJ_DIR axi_stream_if.sv]

# 3. UVM 组件包
xvlog --nolog -sv [file join $PRJ_DIR ofdm_uvm_pkg.sv]

# 4. OFDM RTL 设计
foreach f {mapper mod_mapper pilot_insert xfft_64 cp_insert ofdm_tx_top} {
    xvlog --nolog -sv [file join $SRC_DIR $f.sv]
}

# 5. 顶层
xvlog --nolog -sv [file join $PRJ_DIR tb_ofdm_uvm_top.sv]

# 6. 链接 UVM 库
puts "Elaborating..."
xelab --nolog tb_ofdm_uvm_top -timescale 1ns/1ps

puts "================================================================="
puts " Compilation OK! Run with:"
puts "   xsim tb_ofdm_uvm_top --runall"
puts "================================================================="
