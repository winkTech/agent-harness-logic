# ============================================================================
# ModelSim UVM 编译运行脚本
# 用法: vsim -c -do compile_msim.do
#
# 注意: ModelSim PE 10.6c 不含 UVM 源文件
#       使用 Vivado 提供的 xlnx_uvm_package.sv (带 UVM_NO_DPI 宏)
# ============================================================================

set PRJ_DIR [file dirname [file normalize [info script]]]
set SRC_DIR "$PRJ_DIR/../../../knowledge/primary/domains/comm/ofdm/rtl/src"
set UVM_SRC "C:/Xilinx/Vivado/2023.1/data/system_verilog/uvm_1.2/xlnx_uvm_package.sv"
set DEFINES "+define+UVM_NO_DPI+UVM_CMDLINE_NO_DPI+UVM_HDL_NO_DPI+UVM_REGEX_NO_DPI"

echo "================================================================="
echo " Compiling OFDM UVM Testbench with ModelSim"
echo " PRJ_DIR  = $PRJ_DIR"
echo " SRC_DIR  = $SRC_DIR"
echo " UVM_SRC  = $UVM_SRC"
echo "================================================================="

# ---- Step 0: Clean and create work library ----
rm -rf work
vlib work
vmap work work

# ---- Step 1: Compile Vivado UVM package (with NO-DPI defines) ----
echo "--- Compiling UVM library ---"
if {[catch {vlog -sv $DEFINES $UVM_SRC} result]} {
    echo "ERROR: UVM compilation failed - $result"
    quit -f
}

# ---- Step 2: Compile interfaces ----
echo "--- Compiling interfaces ---"
vlog -sv $PRJ_DIR/reset_if.sv
vlog -sv $PRJ_DIR/axi_stream_if.sv

# ---- Step 3: Compile UVM components ----
echo "--- Compiling UVM testbench ---"
vlog -sv $PRJ_DIR/ofdm_uvm_pkg.sv

# ---- Step 4: Compile OFDM RTL ----
echo "--- Compiling OFDM RTL ---"
vlog -sv $SRC_DIR/mapper.sv
vlog -sv $SRC_DIR/mod_mapper.sv
vlog -sv $SRC_DIR/pilot_insert.sv
vlog -sv $SRC_DIR/xfft_64.sv
vlog -sv $SRC_DIR/cp_insert.sv
vlog -sv $SRC_DIR/ofdm_tx_top.sv

# ---- Step 5: Compile top level ----
echo "--- Compiling top level ---"
vlog -sv $PRJ_DIR/tb_ofdm_uvm_top.sv

# ---- Step 6: Run simulation ----
echo "================================================================="
echo " Running simulation"
echo "================================================================="

vsim -c -voptargs=+acc -t ps -sv_lib uvm work.tb_ofdm_uvm_top \
    +UVM_TESTNAME=ofdm_basic_test \
    +UVM_VERBOSITY=UVM_MEDIUM \
    -do "run -all; quit -f"

echo "================================================================="
echo " Simulation complete"
echo "================================================================="
