# FPGA时序约束与分析规范

> 基于《FPGA时序约束与分析》（吴厚航）整理

---

## 一、时序约束概述

### 1.1 什么是时序约束

- **时序约束定义**：设计者根据实际的系统功能，通过时序约束的方式提出时序要求
- **时序约束目的**：让FPGA编译工具合理地调配FPGA内部有限的布局布线资源，尽可能地满足设计者设定的所有时序要求
- **时序约束本质**：将走线、逻辑电路等产生的延时限制在指定的范围内

### 1.2 为什么要做时序约束

- **时序驱动编译**：Xilinx Vivado综合及实现过程中的编译算法是基于时序驱动的
- **避免随机布局**：没有约束时，FPGA编译工具会随机选择布局布线路径
- **满足设计要求**：通过约束告诉工具设计者期望的目标延时
- **时序收敛**：合理的约束有助于实现时序收敛

---

## 二、基本时序路径

### 2.1 时序路径类型

- **reg2reg**：寄存器到寄存器（内部时序路径）
- **pin2reg**：引脚到寄存器（输入时序路径）
- **reg2pin**：寄存器到引脚（输出时序路径）
- **pin2pin**：引脚到引脚（纯组合逻辑路径）

### 2.2 时序路径延时组成

- **逻辑延时（Tlogic）**：信号通过逻辑门电路产生的延时
- **走线延时（Trouting）**：信号在FPGA内部布线资源上传输产生的延时
- **时钟偏斜（Tclk_skew）**：不同时序单元之间时钟到达时间的差异

### 2.3 建立时间与保持时间

- **建立时间（Tsu）**：时钟上升沿来到之前数据保持稳定不变的最小时间
- **保持时间（Th）**：时钟上升沿来到之后数据保持稳定不变的最小时间
- **建立关系式**：Tco + Tlogic + Trouting + Tsu ≤ Tclk
- **保持关系式**：Tco + Tlogic + Trouting ≥ Th

---

## 三、主时钟约束

```tcl
# 基本语法
create_clock -name <clock_name> -period <period> -waveform {<rise_time> <fall_time>} [get_ports <port_name>]

# 示例：50MHz时钟约束
create_clock -name sys_clk -period 20.000 -waveform {0.000 10.000} [get_ports clk]

# 示例：100MHz时钟约束
create_clock -name clk_100m -period 10.000 -waveform {0.000 5.000} [get_ports clk_p]
```

**要点**：
- 所有输入到FPGA的时钟引脚都必须进行主时钟约束
- 时钟周期单位为ns，例如50MHz对应20ns
- 使用get_ports指定时钟输入引脚

---

## 四、虚拟时钟约束

```tcl
# 基本语法（无目标端口）
create_clock -name <clock_name> -period <period> -waveform {<rise_time> <fall_time>}

# 示例：虚拟时钟约束
create_clock -name vclk -period 10.000 -waveform {0.000 5.000}
```

**应用场景**：时序分析的参考时钟不是FPGA内部的设计时钟

---

## 五、衍生时钟约束

```tcl
# 基本语法
create_generated_clock -name <gen_clock_name> -source <source_pin> -divide_by <factor> [get_pins <output_pin>]
create_generated_clock -name <gen_clock_name> -source <source_pin> -multiply_by <factor> [get_pins <output_pin>]

# 示例：2分频衍生时钟
create_generated_clock -name clk_div2 -source [get_ports clk] -divide_by 2 [get_pins div_reg/Q]

# 示例：2倍频衍生时钟
create_generated_clock -name clk_2x -source [get_ports clk] -multiply_by 2 [get_pins pll_inst/CLKOUT]
```

---

## 六、I/O接口约束

```tcl
# 输入接口约束
set_input_delay -clock <clock_name> -max <max_delay> [get_ports <port_name>]
set_input_delay -clock <clock_name> -min <min_delay> [get_ports <port_name>]

# 输出接口约束
set_output_delay -clock <clock_name> -max <max_delay> [get_ports <port_name>]
set_output_delay -clock <clock_name> -min <min_delay> [get_ports <port_name>]

# 示例
set_input_delay -clock sys_clk -max 3.000 [get_ports data_in]
set_input_delay -clock sys_clk -min 1.000 [get_ports data_in]
set_output_delay -clock sys_clk -max 2.500 [get_ports data_out]
set_output_delay -clock sys_clk -min 0.500 [get_ports data_out]
```

---

## 七、时序例外约束

### 7.1 虚假路径约束

```tcl
# 基本语法
set_false_path -from [get_clocks <clock1>] -to [get_clocks <clock2>]
set_false_path -from [get_cells <cell1>] -to [get_cells <cell2>]
set_false_path -through [get_pins <pin_name>]

# set_clock_groups替代方案（推荐）
set_clock_groups -asynchronous -group [get_clocks CLK_A] -group [get_clocks CLK_B]
set_clock_groups -physically_exclusive -group [get_clocks CLK_A] -group [get_clocks CLK_B]
set_clock_groups -logically_exclusive -group [get_clocks CLK_A] -group [get_clocks CLK_B]
```

**适用场景**：
- 异步时钟域之间的路径（推荐使用set_clock_groups）
- 复位信号路径
- 静态配置信号路径
- 测试/调试专用路径

### 7.2 多周期路径约束

```tcl
# 基本语法
set_multicycle_path <path_count> -setup -from [get_cells <cell1>] -to [get_cells <cell2>]
set_multicycle_path <path_count> -hold -from [get_cells <cell1>] -to [get_cells <cell2>]

# 示例：同频同相时钟的多周期约束
set_multicycle_path 2 -setup -from [get_cells reg_a] -to [get_cells reg_b]
set_multicycle_path 1 -hold -from [get_cells reg_a] -to [get_cells reg_b]
```

**hold值计算公式**：`hold_value = setup_value - 1`

---

## 八、时序约束推荐顺序

```tcl
# 1. 主时钟约束（最先）
create_clock -name clk_50m -period 20.0 [get_ports i_clk]

# 2. 虚拟时钟约束
create_clock -name VIRTUAL_CLK -period 10.0

# 3. 衍生时钟约束（PLL/MMCM自动生成）

# 4. I/O接口约束
set_input_delay -clock clk_50m -max 5.0 [get_ports {i_data[*]}]
set_output_delay -clock clk_50m -max 3.0 [get_ports {o_data[*]}]

# 5. 时序例外约束（最后）
set_false_path -from [get_ports i_rst]
set_multicycle_path 2 -setup -from [get_pins u_slow_reg/C] -to [get_pins u_fast_reg/D]
```

**约束原则**：
- 先约束时钟，再约束I/O
- 时序例外约束放在最后
- 避免过约束或欠约束

---

## 九、时序分析公式

**建立时间检查（Setup Check）**：
```
Data Required Time = Latch Edge + Tclk2 - Tsetup - Tuncertainty
Data Arrival Time  = Launch Edge + Tclk1 + Tlogic + Trouting
Setup Slack = Data Required Time - Data Arrival Time
```

**保持时间检查（Hold Check）**：
```
Data Required Time = Latch Edge + Tclk2 + Thold - Tuncertainty
Data Arrival Time  = Launch Edge + Tclk1 + Tlogic + Trouting
Hold Slack = Data Arrival Time - Data Required Time
```

**Slack判断**：
- Setup Slack > 0：建立时间满足要求
- Setup Slack < 0：建立时间违例（关键路径过长）
- Hold Slack > 0：保持时间满足要求
- Hold Slack < 0：保持时间违例（路径延时过短）

---

## 十、时序违例处理

| 问题 | 解决方案 |
|------|----------|
| Setup违例 | 关键路径过长，需要优化逻辑或增加流水线 |
| Hold违例 | 路径延时过短，需要增加延时或调整布局 |
| 时钟违例 | 时钟质量不好，需要优化时钟树 |
