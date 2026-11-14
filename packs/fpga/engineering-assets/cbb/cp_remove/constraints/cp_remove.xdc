# cp_remove OOC 综合约束 — 100 MHz
# 与上游 sync_top、下游 fft64_sdf 同一时钟域, 级联时无需跨时钟处理。
create_clock -period 10.000 -name i_clk [get_ports i_clk]
