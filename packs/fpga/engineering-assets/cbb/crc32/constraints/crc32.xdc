# crc32 OOC 综合约束 — 200 MHz
# 关键路径为单拍内 8 步反射式 CRC 展开的异或树, 故目标低于 lfsr_gen 的 250MHz
create_clock -period 5.000 -name i_clk [get_ports i_clk]
