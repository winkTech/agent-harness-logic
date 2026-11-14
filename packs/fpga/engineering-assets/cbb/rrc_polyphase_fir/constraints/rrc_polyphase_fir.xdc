#-----------------------------------------------------------------
# rrc_polyphase_fir — 时序约束 (CBB 核级 / out-of-context)
#
# 依据: manifest.json 已声明 clock={name:i_clk, period_ns:4},
#       constraints.target.fmax=250MHz。本文件只把该契约机器化,
#       不引入新的时序决策。
#
# G-C-01 交叉核对: required_period_ns = 1000/250 = 4.000
#                  本文件 create_clock -period 4.000 (未松于目标)
#-----------------------------------------------------------------

create_clock -name i_clk -period 4.000 [get_ports i_clk]

#-----------------------------------------------------------------
# I/O 预算 —— 显式假设, 非实测
#
# CBB 核级签核只对内部 reg-to-reg 路径负责; 板级 I/O 延时归集成方。
# 此处按周期 25% (1.000ns) 各留给输入/输出侧作为占位预算, 使 I/O
# 路径受约束而不是以"未约束路径"形式静默逃逸检查。
# 集成到具体系统时必须以真实板级数值复核。
#-----------------------------------------------------------------
set IO_BUDGET 1.000

set_input_delay  -clock i_clk -max $IO_BUDGET [get_ports {s_axis_tvalid s_axis_tdata[*] m_axis_tready}]
set_input_delay  -clock i_clk -min 0.100      [get_ports {s_axis_tvalid s_axis_tdata[*] m_axis_tready}]

set_output_delay -clock i_clk -max $IO_BUDGET [get_ports {s_axis_tready m_axis_tvalid m_axis_tdata[*]}]
set_output_delay -clock i_clk -min 0.100      [get_ports {s_axis_tready m_axis_tvalid m_axis_tdata[*]}]

# 同步复位 i_rst 由外部同步逻辑驱动, 按同周期时序处理 (不设 false_path,
# 避免以"忽略"方式掩盖复位路径时序)
set_input_delay  -clock i_clk -max $IO_BUDGET [get_ports i_rst]
set_input_delay  -clock i_clk -min 0.100      [get_ports i_rst]
