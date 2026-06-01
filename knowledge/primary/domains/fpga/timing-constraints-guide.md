---
title: "FPGA 时序约束指南"
domain: fpga
tags: [timing, constraints, vivado, analysis]
created: 2026-06-01
updated: 2026-06-01
difficulty: advanced
sources:
  - "FPGA时序约束与分析.pdf"
  - "Vivado从此开始（进阶篇）.pdf"
---

# FPGA 时序约束指南

## 概述

时序约束是 FPGA 设计的关键环节，直接影响设计能否正常工作。

---

## 一、时序基础

### 关键概念

| 概念 | 说明 |
|------|------|
| **建立时间 (Setup)** | 数据在时钟沿到来前必须稳定的最小时间 |
| **保持时间 (Hold)** | 数据在时钟沿到来后必须保持的最小时间 |
| **时钟偏移 (Skew)** | 时钟到达不同触发器的时间差异 |
| **时钟抖动 (Jitter)** | 时钟边沿的不确定性 |

### 时序路径

```
起点 → [组合逻辑] → [时序逻辑] → [组合逻辑] → 终点
```

**四种路径**：
1. 建立时间路径
2. 保持时间路径
3. 时钟到输出路径
4. 输入到时钟路径

---

## 二、约束类型

### 1. 时钟约束

```tcl
# 主时钟
create_clock -period 10.000 -name clk_100m [get_ports i_clk]

# 生成时钟
create_generated_clock -name clk_50m \
    -source [get_pins pll/clk_in] \
    -divide_by 2 \
    [get_pins pll/clk_out]

# 时钟组（异步时钟）
set_clock_groups -asynchronous \
    -group [get_clocks clk_a] \
    -group [get_clocks clk_b]
```

### 2. I/O 约束

```tcl
# 输入延迟
set_input_delay -clock clk_100m -max 5.000 [get_ports i_data]
set_input_delay -clock clk_100m -min 2.000 [get_ports i_data]

# 输出延迟
set_output_delay -clock clk_100m -max 5.000 [get_ports o_result]
set_output_delay -clock clk_100m -min 2.000 [get_ports o_result]
```

### 3. 虚假路径

```tcl
# 跨时钟域
set_false_path -from [get_clocks clk_a] -to [get_clocks clk_b]

# 异步复位
set_false_path -from [get_ports i_rst]

# 互斥路径
set_false_path -through [get_pins mux/sel]
```

### 4. 多周期路径

```tcl
# 2 周期路径
set_multicycle_path -setup 2 -from [get_pins reg_a/D] -to [get_pins reg_b/D]
set_multicycle_path -hold 1 -from [get_pins reg_a/D] -to [get_pins reg_b/D]
```

---

## 三、约束策略

### 1. 时钟约束策略

| 策略 | 方法 |
|------|------|
| **主时钟** | 使用 `create_clock` |
| **生成时钟** | 使用 `create_generated_clock` |
| **异步时钟** | 使用 `set_clock_groups` |
| **门控时钟** | 使用 `set_clock_latency` |

### 2. I/O 约束策略

| 策略 | 方法 |
|------|------|
| **同步接口** | 参考时钟约束 |
| **异步接口** | 设置最大延迟 |
| **源同步** | 使用 `set_output_delay -clock_fall` |

### 3. 跨时钟域策略

| 方法 | 适用场景 |
|------|----------|
| **同步器** | 单bit信号 |
| **FIFO** | 多bit数据流 |
| **握手协议** | 控制信号 |
| **异步FIFO** | 高性能场景 |

---

## 四、分析方法

### 1. 时序报告

```tcl
# 生成时序报告
report_timing_summary -file timing_report.rpt

# 查看关键路径
report_timing -nworst 10 -delay_type min_max
```

### 2. 关键指标

| 指标 | 说明 | 目标 |
|------|------|------|
| **WNS** | 最差负裕量 | ≥ 0 |
| **TNS** | 总负裕量 | = 0 |
| **WHS** | 最差保持裕量 | ≥ 0 |
| **THS** | 总保持裕量 | = 0 |

### 3. 优化方法

| 问题 | 解决方案 |
|------|----------|
| **建立时间违例** | 优化逻辑、插入流水线 |
| **保持时间违例** | 插入延迟、调整布局 |
| **时钟偏移** | 使用 BUFG、优化时钟树 |

---

## 五、常见问题

### 1. 时钟抖动

**原因**：
- 时钟源质量差
- 电源噪声
- 串扰

**解决**：
- 使用高质量时钟源
- 优化电源设计
- 使用时钟缓冲器

### 2. 时钟偏移

**原因**：
- 时钟树不平衡
- 布线延迟差异

**解决**：
- 使用 BUFG
- 平衡时钟树
- 使用时钟约束

### 3. 亚稳态

**原因**：
- 违反建立/保持时间
- 跨时钟域信号

**解决**：
- 使用同步器
- 使用握手协议
- 使用异步FIFO

---

## 六、最佳实践

### 约束编写
- [ ] 定义所有时钟
- [ ] 约束所有 I/O
- [ ] 标记虚假路径
- [ ] 标记多周期路径
- [ ] 使用时钟组

### 时序分析
- [ ] 检查 WNS/TNS
- [ ] 分析关键路径
- [ ] 检查保持时间
- [ ] 验证时钟约束

### 优化设计
- [ ] 插入流水线
- [ ] 优化逻辑层级
- [ ] 使用寄存器
- [ ] 避免组合逻辑环路

---

## 参考资源

- [FPGA时序约束与分析.pdf](../../../source/datasheets/coding-standards/)
- [Vivado从此开始（进阶篇）.pdf](../../../source/datasheets/vivado/)
- [Xilinx 时序约束指南](https://www.xilinx.com/support/documentation/)
