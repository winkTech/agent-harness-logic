# fft64_sdf OOC 综合约束 — 100 MHz
# 目标与库内同域资产一致 (sync_top / channel_est_top / ofdm_tx_top 均为 100MHz),
# 便于在同一时钟域下直接级联而无需跨时钟处理。
create_clock -period 10.000 -name i_clk [get_ports i_clk]
