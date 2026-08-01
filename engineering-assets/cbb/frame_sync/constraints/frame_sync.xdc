# frame_sync OOC 综合约束 — 250 MHz
# 关键路径为 FSM 次态组合 (状态 + 字节比较 + 前导计数比较)
create_clock -period 4.000 -name i_clk [get_ports i_clk]
