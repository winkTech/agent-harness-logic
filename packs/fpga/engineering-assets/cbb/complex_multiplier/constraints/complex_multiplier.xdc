# complex_multiplier OOC 综合约束 — 250 MHz
# 三级流水 (输入寄存 / 四乘积 / 加减), 关键路径为 DSP48 乘法级
create_clock -period 4.000 -name i_clk [get_ports i_clk]
