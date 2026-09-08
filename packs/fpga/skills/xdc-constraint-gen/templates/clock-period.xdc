# =====================================================================
# 时钟约束模板 — clock-period.xdc
# 语法权威示例。手写补充时钟约束时照抄本文件格式。
# 参考: Xilinx UG949 (UltraFast 方法论) / UG974 (约束入门)
# =====================================================================

# ---- 主时钟（晶振/外部输入）------------------------------------------
# <period_ns> 为必填；占空比对称时可省略 -waveform
create_clock -period 20.000 -name sys_clk -waveform {0.000 10.000} [get_ports sys_clk]

# ---- 差分时钟对（只约束 P 端，N 端自动配对）--------------------------
create_clock -period 6.400 -name adc_clk_p [get_ports adc_clk_p]

# ---- 生成时钟（MMCM/PLL 输出，在生成时钟的源引脚上定义）--------------
# 对象是 cell 引脚，不是顶层端口；-source 指输入引脚
create_generated_clock -name clk_cpu \
  -source [get_pins mmcm_inst/CLKIN1] \
  -multiply_by 2 \
  [get_pins mmcm_inst/CLKOUT0]

# ---- 时钟使能/分频使能时钟（灰色地带，按 UG949 应优先用 -edges）------
# create_generated_clock -name clk_div2 -source [get_pins div_ff_reg/Q] -divide_by 2 [get_pins div_ff_reg/Q]
