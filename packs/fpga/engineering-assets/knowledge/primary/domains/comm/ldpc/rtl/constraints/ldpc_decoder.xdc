#-----------------------------------------------------------------
# LDPC Decoder Timing Constraints for Vivado
# Target: Xilinx Zynq UltraScale+ (XCZU67DR)
#-----------------------------------------------------------------

# 主时钟: 100-200 MHz
create_clock -name clk_sys -period 10.000 [get_ports i_clk_sys]

# 输入延时 (假设外部寄存器驱动, 2ns board delay)
set_input_delay -clock clk_sys -max 3.000 [get_ports s_axis_llr_tdata]
set_input_delay -clock clk_sys -min 1.000 [get_ports s_axis_llr_tdata]
set_input_delay -clock clk_sys -max 3.000 [get_ports s_axis_llr_tvalid]
set_input_delay -clock clk_sys -min 1.000 [get_ports s_axis_llr_tvalid]

# 输入延时 (编码器)
set_input_delay -clock clk_sys -max 3.000 [get_ports s_axis_info_tdata]
set_input_delay -clock clk_sys -min 1.000 [get_ports s_axis_info_tdata]

# 输出延时 (外部触发器建立时间 1ns, 板级走线 1ns)
set_output_delay -clock clk_sys -max 2.000 [get_ports m_axis_data_tdata]
set_output_delay -clock clk_sys -min 0.500 [get_ports m_axis_data_tdata]
set_output_delay -clock clk_sys -max 2.000 [get_ports m_axis_data_tvalid]
set_output_delay -clock clk_sys -min 0.500 [get_ports m_axis_data_tvalid]

# 输出延时 (编码器)
set_output_delay -clock clk_sys -max 2.000 [get_ports m_axis_code_tdata]
set_output_delay -clock clk_sys -min 0.500 [get_ports m_axis_code_tdata]

# 异步复位 (false path)
set_false_path -from [get_ports i_rst_sys]

# BRAM 时序宽松 (内部路径)
set_max_delay -from [get_cells -hier -filter {NAME =~ *r_mem*}] -to [get_cells] 8.000

#-----------------------------------------------------------------
# 报告
#-----------------------------------------------------------------
report_timing -nworst 10 -setup
report_timing -nworst 10 -hold
report_utilization
