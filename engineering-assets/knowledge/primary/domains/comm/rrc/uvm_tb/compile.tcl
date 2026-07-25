# ============================================================================
# RRC UVM 编译脚本 (Vivado xsim)
# 用法: xsim tb_rrc_uvm_top --runall
# ============================================================================

set UVM_VER 1.2
set PRJ_DIR [file dirname [file normalize [info script]]]
set RRC_SRC [file join $PRJ_DIR "../rtl/src"]
set TEMPLATE [file join $PRJ_DIR "../../../../../docs/templates/uvm"]
set UVM_SRC "C:/Xilinx/Vivado/2023.1/data/system_verilog/uvm_1.2/xlnx_uvm_package.sv"
set UVM_DEFINES "--define UVM_NO_DPI --define UVM_CMDLINE_NO_DPI --define UVM_HDL_NO_DPI --define UVM_REGEX_NO_DPI"

puts "================================================================="
puts " Compiling RRC UVM Testbench"
puts "================================================================="

# 1. Vivado UVM 包
xvlog --nolog -sv $UVM_DEFINES $UVM_SRC

# 2. 接口
xvlog --nolog -sv [file join $TEMPLATE reset_if.sv]
xvlog --nolog -sv [file join $TEMPLATE axi_stream_if.sv]

# 3. UVM 组件包
xvlog --nolog -sv [file join $PRJ_DIR rrc_uvm_pkg.sv]

# 4. RRC RTL 设计
foreach f {rrc_coeff_pkg rrc_polyphase_fir rrc_top} {
    xvlog --nolog -sv [file join $RRC_SRC $f.sv]
}

# 5. 顶层
xvlog --nolog -sv [file join $PRJ_DIR tb_rrc_uvm_top.sv]

# 6. 链接
puts "Elaborating..."
xelab --nolog tb_rrc_uvm_top -timescale 1ns/1ps

puts "================================================================="
puts " Compilation OK! Run: xsim tb_rrc_uvm_top --runall"
puts "================================================================="