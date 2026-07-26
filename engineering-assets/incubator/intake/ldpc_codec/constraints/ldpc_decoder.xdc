#-----------------------------------------------------------------
# LDPC Decoder Timing Constraints (Vivado)
# 器件以 manifest.json 的 device.part 为准: xc7k325tffg900-2
#   (原抬头写 XCZU67DR, 与 manifest 冲突; 综合与判读均按 manifest 走)
#-----------------------------------------------------------------

# 主时钟 100 MHz
create_clock -name clk_sys -period 10.000 [get_ports i_clk_sys]

# 输入延时 (假设外部寄存器驱动, 板级走线 1~3 ns)
set_input_delay -clock clk_sys -max 3.000 [get_ports s_axis_llr_tdata*]
set_input_delay -clock clk_sys -min 1.000 [get_ports s_axis_llr_tdata*]
set_input_delay -clock clk_sys -max 3.000 [get_ports s_axis_llr_tvalid]
set_input_delay -clock clk_sys -min 1.000 [get_ports s_axis_llr_tvalid]
set_input_delay -clock clk_sys -max 3.000 [get_ports m_axis_data_tready]
set_input_delay -clock clk_sys -min 1.000 [get_ports m_axis_data_tready]

# 输出延时 (外部触发器建立 1ns + 板级走线 1ns)
set_output_delay -clock clk_sys -max 2.000 [get_ports m_axis_data_tdata]
set_output_delay -clock clk_sys -min 0.500 [get_ports m_axis_data_tdata]
set_output_delay -clock clk_sys -max 2.000 [get_ports m_axis_data_tvalid]
set_output_delay -clock clk_sys -min 0.500 [get_ports m_axis_data_tvalid]
set_output_delay -clock clk_sys -max 2.000 [get_ports s_axis_llr_tready]
set_output_delay -clock clk_sys -min 0.500 [get_ports s_axis_llr_tready]

# i_rst_sys 是**同步**复位 (manifest reset.type = sync), 必须参与时序分析。
# 原本这里有一条 `set_false_path -from [get_ports i_rst_sys]`, 把复位的全部
# 扇出路径整体移出分析 —— 那条约束成立的前提是异步复位, 与本设计不符,
# 它让 G-C-01 的 WNS 数字失去意义。已删除。
set_input_delay -clock clk_sys -max 3.000 [get_ports i_rst_sys]
set_input_delay -clock clk_sys -min 1.000 [get_ports i_rst_sys]

# 说明: 原有的
#   set_max_delay -from [get_cells -hier -filter {NAME =~ *r_mem*}] -to [get_cells] 8.000
# 在综合日志里成片报 [Constraints 18-401/18-402] "not a valid endpoint/startpoint",
# 实际一条路径都没约束住; 存储器读出已改为同步读, 本就不需要该例外, 一并删除。
#
# 编码器端口 (s_axis_info_tdata / m_axis_code_tdata) 的约束原本也写在这里,
# 但本 xdc 作用于顶层 ldpc_decoder_top, 那些端口不存在, 综合报
# [Vivado 12-4739] No valid object(s) found。已移出 —— 编码器需要时应有自己的 xdc。
#
# report_timing / report_utilization 是 tcl 流程命令, 写在 xdc 里非法,
# 同样报 CRITICAL WARNING。报告由 tools/pg-synth.tcl 统一生成。
