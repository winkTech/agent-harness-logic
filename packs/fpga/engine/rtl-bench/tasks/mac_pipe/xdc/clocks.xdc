## OOC 综合约束 — mac_pipe @ 250 MHz
## (实测 ref 在 xc7a100t-2 上 DSP MACC 动态 OPMODE 路径 ≈3.44ns,400MHz 不可达)
create_clock -name clk -period 4.000 [get_ports clk]
