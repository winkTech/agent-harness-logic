# =====================================================================
# 管脚分配模板 — pin-assignment.xdc
# 语法权威示例。引脚号与电平标准以原理图/netlist 为准，禁止拍脑袋。
# 参考: Xilinx UG471 (7-Series SelectIO) / UG571 (UltraScale SelectIO)
# =====================================================================

# ---- 基本形式：引脚号 + 电平标准缺一不可 ------------------------------
set_property -dict {PACKAGE_PIN H16 IOSTANDARD LVCMOS33} [get_ports {led[0]}]
set_property -dict {PACKAGE_PIN A18 IOSTANDARD LVCMOS33} [get_ports {rst_n}]

# ---- 多 bit 端口逐 bit 写（不要用通配符批绑，审查时无法对账）----------
set_property -dict {PACKAGE_PIN J17 IOSTANDARD LVCMOS33} [get_ports {led[1]}]
set_property -dict {PACKAGE_PIN J18 IOSTANDARD LVCMOS33} [get_ports {led[2]}]

# ---- 差分对（P/N 成对分配，MACRO 原语对在 RTL 里例化）-----------------
set_property -dict {PACKAGE_PIN T8  IOSTANDARD LVDS_25} [get_ports {adc_dat_p}]
set_property -dict {PACKAGE_PIN T7  IOSTANDARD LVDS_25} [get_ports {adc_dat_n}]

# ---- 可选属性：上下拉 / SLEW / DRIVE ---------------------------------
set_property PULLUP true  [get_ports {btn_n}]
set_property SLEW FAST    [get_ports {dbg_pin}]
set_property DRIVE 8      [get_ports {dbg_pin}]
