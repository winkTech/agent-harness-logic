# =====================================================================
# 时序例外模板 — timing-exception.xdc
# 语法权威示例。例外约束必须逐条可解释 —— 每条写明为什么该路径不分析。
# 参考: Xilinx UG906 (时序收敛) 第 3 章 Timing Exceptions
# =====================================================================

# ---- 异步复位：复位引脚到所有触发器，false_path -----------------------
# 只对真正的异步复位用；同步复位链禁止加
set_false_path -from [get_ports {rst_n}]

# ---- 跨时钟域：单 bit 打两拍同步器（先在 RTL 里例化 xpm_cdc_single）--
# UG949 推荐 max_delay 优先于 false_path，约束同步器内部的路径
set_max_delay -datapath_only 5.000 -from [get_pins sync_reg_a_reg/Q] \
  -to [get_pins sync_reg_b_reg/D]

# ---- 整组时钟不相关（等价于组间互 false_path，写法更省）---------------
# 只有确认两域之间除同步器外无任何数据路径时才能用组级约束
set_clock_groups -asynchronous \
  -group [get_clocks sys_clk] \
  -group [get_clocks adc_clk_p]

# ---- 输入/输出端口时延（板级时序预算，配合 set_input_delay）-----------
# 源同步接口才需要；数值来自外部器件数据手册
# set_input_delay -clock adc_clk_p -max 1.500 [get_ports {adc_dat_p}]
# set_input_delay -clock adc_clk_p -min 0.500 [get_ports {adc_dat_p}]
