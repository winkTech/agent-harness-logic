# OFDM UVM Testbench

## 位置

UVM 模板和源文件位于 `docs/templates/uvm/`，含完整的 OFDM UVM 验证环境：

| 文件 | 路径 |
|:----|:-----|
| UVM 组件 | `docs/templates/uvm/ofdm_uvm_pkg.sv` |
| 接口定义 | `docs/templates/uvm/axi_stream_if.sv` |
| 顶层 | `docs/templates/uvm/tb_ofdm_uvm_top.sv` |
| 编译脚本 | `docs/templates/uvm/compile.tcl` |
| 知识文档 | `knowledge/primary/domains/fpga/uvm-verification-guide.md` |

## 运行

```bash
cd ~/.claude/docs/templates/uvm
xvlog --nolog -sv --define UVM_NO_DPI --define UVM_CMDLINE_NO_DPI \
      --define UVM_HDL_NO_DPI --define UVM_REGEX_NO_DPI \
      /c/Xilinx/Vivado/2023.1/data/system_verilog/uvm_1.2/xlnx_uvm_package.sv
xvlog --nolog -sv axi_stream_if.sv
xvlog --nolog -sv ofdm_uvm_pkg.sv
xvlog --nolog -sv ../../rtl/src/mapper.sv
xvlog --nolog -sv ../../rtl/src/mod_mapper.sv
xvlog --nolog -sv ../../rtl/src/pilot_insert.sv
xvlog --nolog -sv ../../rtl/src/xfft_64.sv
xvlog --nolog -sv ../../rtl/src/cp_insert.sv
xvlog --nolog -sv ../../rtl/src/ofdm_tx_top.sv
xvlog --nolog -sv tb_ofdm_uvm_top.sv
xelab --nolog tb_ofdm_uvm_top -timescale 1ns/1ps
xsim tb_ofdm_uvm_top --runall
```

## 状态

✅ UVM 验证框架已通过 Vivado xsim 2023.1 编译和仿真验证。
640 笔 AXI-Stream 交易走通完整数据通路: sequence → sequencer → driver → DUT → monitor → scoreboard。
