# ddr_axi4_controller OOC 综合约束 — 200 MHz
# 对接 Xilinx MIG 的 AXI4 用户侧时钟, 典型 200MHz; 512 位数据通路
create_clock -period 5.000 -name i_clk [get_ports i_clk]
