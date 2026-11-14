# ============================================================================
# Sync UVM 编译脚本 (Vivado xsim)
# ============================================================================

set UVM_VER 1.2
set PRJ_DIR [file dirname [file normalize [info script]]]
set SYNC_SRC [file join $PRJ_DIR "../rtl/src"]
set TEMPLATE [file join $PRJ_DIR "../../../../../docs/templates/uvm"]
set UVM_SRC "C:/Xilinx/Vivado/2023.1/data/system_verilog/uvm_1.2/xlnx_uvm_package.sv"
set UVM_DEFINES "--define UVM_NO_DPI --define UVM_CMDLINE_NO_DPI --define UVM_HDL_NO_DPI --define UVM_REGEX_NO_DPI"

puts "================================================================="
puts " Compiling Sync UVM Testbench"
puts "================================================================="

xvlog --nolog -sv $UVM_DEFINES $UVM_SRC
xvlog --nolog -sv [file join $TEMPLATE reset_if.sv]
xvlog --nolog -sv [file join $TEMPLATE axi_stream_if.sv]
xvlog --nolog -sv [file join $PRJ_DIR sync_uvm_pkg.sv]

foreach f {sync_pkg packet_detect fine_timing cordic_core sync_top} {
    xvlog --nolog -sv [file join $SYNC_SRC $f.sv]
}

xvlog --nolog -sv [file join $PRJ_DIR tb_sync_uvm_top.sv]
xelab --nolog tb_sync_uvm_top -timescale 1ns/1ps

puts "Compilation OK! Run: xsim tb_sync_uvm_top --runall"