# mod_demapper OOC 综合约束 — 100 MHz
# 与上游 eq_zf / 下游 ldpc_codec 同一时钟域, 级联时无跨时钟处理。
#
# 100 MHz 不是随手取的: OFDM 符号 = 80 样点 @20 MHz = 4 us = 400 拍,
# 64QAM 每符号 48 x 6 = 288 个 LLR 必须在这 400 拍内串行出完 (实测 6.9 拍/点)。
# 时钟一旦下调到 20 MHz, 串行 LLR 输出这个接口形状就不成立了 —— 见 README §吞吐。
create_clock -period 10.000 -name i_clk [get_ports i_clk]
