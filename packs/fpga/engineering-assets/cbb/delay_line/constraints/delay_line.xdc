# delay_line OOC 综合约束 — 250 MHz
# 纯移位链, 无组合运算; 关键路径为寄存器到寄存器
create_clock -period 4.000 -name i_clk [get_ports i_clk]
