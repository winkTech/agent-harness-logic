# ============================================================================
# LDPC UVM 编译脚本 (Vivado xsim)
# 用法: xsim tb_ldpc_uvm_top --runall
# ============================================================================

set UVM_VER 1.2
set PRJ_DIR [file dirname [file normalize [info script]]]
set LDPC_SRC [file join $PRJ_DIR "../rtl/01_rtl"]
set TEMPLATE [file join $PRJ_DIR "../../../../../docs/templates/uvm"]
set UVM_SRC "C:/Xilinx/Vivado/2023.1/data/system_verilog/uvm_1.2/xlnx_uvm_package.sv"
set UVM_DEFINES "--define UVM_NO_DPI --define UVM_CMDLINE_NO_DPI --define UVM_HDL_NO_DPI --define UVM_REGEX_NO_DPI"

puts "================================================================="
puts " Compiling LDPC Decoder UVM Testbench"
puts "================================================================="

# 1. Vivado UVM 包
xvlog --nolog -sv $UVM_DEFINES $UVM_SRC

# 2. 接口
xvlog --nolog -sv [file join $TEMPLATE reset_if.sv]

# 3. UVM 组件包
xvlog --nolog -sv [file join $PRJ_DIR ldpc_uvm_pkg.sv]

# 4. LDPC RTL 设计
# 注意: ldpc_defines.vh 是宏头文件, 通过 `include 在模块中引用
# 先编译 HDL 源文件 (包含 .vh 路径)
xvhdl --nolog [file join $LDPC_SRC ldpc_defines.vh]
xvlog --nolog -sv [file join $LDPC_SRC ldpc_controller.v]
xvlog --nolog -sv [file join $LDPC_SRC cn_update.v]
xvlog --nolog -sv [file join $LDPC_SRC early_term.v]
xvlog --nolog -sv [file join $LDPC_SRC h_matrix_addr.v]
xvlog --nolog -sv [file join $LDPC_SRC llr_buffer.v]
xvlog --nolog -sv [file join $LDPC_SRC msg_buffer.v]
xvlog --nolog -sv [file join $LDPC_SRC ldpc_decoder_top.v]

# 5. 顶层
xvlog --nolog -sv [file join $PRJ_DIR tb_ldpc_uvm_top.sv]

# 6. 链接
puts "Elaborating..."
xelab --nolog tb_ldpc_uvm_top -timescale 1ns/1ps

puts "================================================================="
puts " Compilation OK! Run: xsim tb_ldpc_uvm_top --runall"
puts "================================================================="
