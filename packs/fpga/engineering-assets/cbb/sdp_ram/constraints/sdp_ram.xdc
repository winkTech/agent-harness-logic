# sdp_ram OOC 综合约束 — 250 MHz
# 关键路径为 BRAM 时钟到输出寄存器
create_clock -period 4.000 -name i_clk [get_ports i_clk]
