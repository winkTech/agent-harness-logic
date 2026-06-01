---
title: "FPGA 设计指南"
domain: fpga
tags: [design, guide, best-practices, vivado]
created: 2026-06-01
updated: 2026-06-01
difficulty: intermediate
sources:
  - "玩转FPGA.pdf"
  - "AMD FPGA设计优化宝典.pdf"
  - "FPGA设计——基于团队的最佳实践.pdf"
  - "FPGA代码规范.pdf"
---

# FPGA 设计指南

## 概述

本文档汇总了 FPGA 设计的核心知识，来源于多本专业书籍和最佳实践。

---

## 一、FPGA 基础概念

### 什么是 FPGA

- **全称**: Field Programmable Gate Array（现场可编程门阵列）
- **特点**: 可反复擦写的芯片
- **优势**: 灵活、快速迭代、无需流片

### FPGA vs ASIC

| 维度 | FPGA | ASIC |
|------|------|------|
| **开发周期** | 短（天/周） | 长（月/年） |
| **成本** | 单位成本高 | 量产成本低 |
| **灵活性** | 可重新配置 | 固定功能 |
| **适用场景** | 原型验证、小批量 | 大批量生产 |

---

## 二、设计流程

### 标准流程

```
需求分析 → 架构设计 → HDL编码 → 仿真验证
    ↓
综合 → 布局布线 → 时序分析 → 下载验证
```

### 关键步骤

| 步骤 | 工具 | 输出 |
|------|------|------|
| **综合** | Vivado Synthesis | 网表文件 |
| **布局布线** | Vivado Implementation | 比特流文件 |
| **时序分析** | Vivado Timing Analysis | 时序报告 |
| **仿真** | Vivado Simulator / ModelSim | 波形文件 |

---

## 三、编码规范

### 1. 命名规范

| 类型 | 前缀 | 示例 |
|------|------|------|
| 输入信号 | `i_` | `i_clk`, `i_data` |
| 输出信号 | `o_` | `o_valid`, `o_result` |
| 寄存器 | `r_` | `r_counter`, `r_state` |
| 线网 | `w_` | `w_enable`, `w_ready` |
| 寄存输入 | `ri_` | `ri_rx_data` |
| 寄存输出 | `ro_` | `ro_result` |
| 参数/状态 | `P_` | `P_ST_IDLE` |
| 跨时钟域 | `xx_cdc` | `data_cdc` |

### 2. 代码结构顺序

```verilog
module module_name (
    // 1. 系统信号
    input  i_clk,
    input  i_rst,
    
    // 2. 输入接口
    input  [7:0] i_data,
    
    // 3. 输出接口
    output [7:0] o_result
);

// 4. 输入信号寄存 (ri_)
// 5. 输出信号寄存 (ro_) 和 assign
// 6. 参数/状态定义 (P_)
// 7. 例化模块
// 8. 状态机实现
// 9. 组合逻辑
// 10. 时序逻辑
// 11. 数组赋值

endmodule
```

### 3. 复位规范

```verilog
// ✅ 推荐：同步高电平复位
always @(posedge i_clk) begin
    if (i_rst) begin
        r_counter <= 'd0;  // 必须显式初始化
    end
    else begin
        // 其他逻辑
    end
end
```

---

## 四、时序约束

### 1. 时钟约束

```tcl
# 创建主时钟
create_clock -period 10.000 -name clk_100m [get_ports i_clk]

# 创建生成时钟
create_generated_clock -name clk_50m -source [get_pins pll/clk_in] -divide_by 2 [get_pins pll/clk_out]
```

### 2. I/O 约束

```tcl
# 输入延迟
set_input_delay -clock clk_100m -max 5.000 [get_ports i_data]

# 输出延迟
set_output_delay -clock clk_100m -max 5.000 [get_ports o_result]
```

### 3. 虚假路径

```tcl
# 跨时钟域
set_false_path -from [get_clocks clk_a] -to [get_clocks clk_b]

# 异步复位
set_false_path -from [get_ports i_rst]
```

---

## 五、常见陷阱

### 1. 锁存器推断

**问题**: 缺少 default 分支
```verilog
// ❌ 错误
always @(*) begin
    case (sel)
        2'b00: y = a;
        2'b01: y = b;
    endcase
end
```

**解决**: 添加 default
```verilog
always @(*) begin
    case (sel)
        2'b00: y = a;
        2'b01: y = b;
        default: y = 1'b0;
    endcase
end
```

### 2. 阻塞与非阻塞混用

**问题**: 时序逻辑中使用阻塞赋值
```verilog
// ❌ 错误
always @(posedge clk) begin
    a = b;  // 阻塞
    c <= a;  // 非阻塞，但 a 已经变了
end
```

**解决**: 统一使用非阻塞
```verilog
always @(posedge clk) begin
    a <= b;
    c <= a;
end
```

### 3. 全局复位问题

**问题**: 全局复位影响时序和资源

**解决**: 
- 最小化复位范围
- 使用局部复位
- 考虑上电初始化

---

## 六、优化技巧

### 1. 资源共享

```verilog
// ✅ 共享运算单元
assign sum = (sel) ? (a + c) : (b + c);
```

### 2. 流水线

```verilog
// 两级流水线
always @(posedge clk) begin
    stage1 <= a * b;
    stage2 <= stage1 + c;
    result <= stage2;
end
```

### 3. 状态机编码

```verilog
// 独热码（速度快）
localparam [3:0]
    S_IDLE = 4'b0001,
    S_RUN  = 4'b0010,
    S_DONE = 4'b0100;
```

---

## 七、调试技巧

| 方法 | 工具 | 用途 |
|------|------|------|
| **波形仿真** | Vivado Simulator | 功能验证 |
| **ILA 抓取** | Integrated Logic Analyzer | 在线调试 |
| **VIO** | Virtual I/O | 动态控制 |
| **Tcl 脚本** | Vivado Tcl | 自动化分析 |

---

## 八、最佳实践清单

### 编码阶段
- [ ] 使用非阻塞赋值（时序逻辑）
- [ ] 使用 `always @(*)`（组合逻辑）
- [ ] 添加 default 分支
- [ ] 遵循命名规范
- [ ] 添加充分注释

### 综合阶段
- [ ] 检查锁存器推断
- [ ] 验证时序约束
- [ ] 分析资源利用率

### 实现阶段
- [ ] 检查时序收敛
- [ ] 分析关键路径
- [ ] 优化布局布线

---

## 参考资源

- [玩转FPGA.pdf](../../../source/datasheets/fpga-design/)
- [AMD FPGA设计优化宝典.pdf](../../../source/datasheets/fpga-design/)
- [FPGA设计——基于团队的最佳实践.pdf](../../../source/datasheets/fpga-design/)
- [FPGA代码规范.pdf](../../../source/datasheets/coding-standards/)
