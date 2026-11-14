# cdc_sync OOC 综合约束 — 双异步时钟域
#
# 两域取不同频率且互质关系, 使跨域路径不会因偶然同频而被误判为安全:
#   src 100 MHz (10.000 ns) / dst 150 MHz (6.666 ns)
create_clock -period 10.000 -name clk_src [get_ports i_clk_src]
create_clock -period  6.666 -name clk_dst [get_ports i_clk_dst]

# 跨域路径约束
#
# 刻意**不用** set_clock_groups -asynchronous —— 那会让工具完全忽略跨域路径,
# 连数据通路延迟都不再约束, 源寄存器到同步链首级的走线可以任意长, 一旦超过
# 目的域一个周期就会破坏同步器的亚稳态收敛前提。
#
# 改用 set_max_delay -datapath_only: 既解除建立/保持关系 (跨域本就无相位关系),
# 又把数据通路延迟限制在目的域一个周期内 —— 这是 Xilinx 对 CDC 的推荐做法。
set_max_delay -datapath_only -from [get_clocks clk_src] -to [get_clocks clk_dst]  6.666
set_max_delay -datapath_only -from [get_clocks clk_dst] -to [get_clocks clk_src] 10.000

# 同步链本身由 RTL 的 (*ASYNC_REG*) 属性保证被放在同一 slice 内,
# 不依赖使用方在顶层补约束 (原模板正是把这件事外包给了使用者)。
