## axis_skid_buffer — OOC 综合约束
## 目标 250 MHz @ xc7k325tffg900-2 (寄存切片应远快于此; 约束取库内流式链路的常用工作点)
create_clock -name i_clk -period 4.000 [get_ports i_clk]
