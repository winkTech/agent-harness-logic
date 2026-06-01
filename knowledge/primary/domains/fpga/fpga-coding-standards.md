---
title: "FPGA 代码规范"
domain: fpga
tags: [coding-standards, verilog, style, review]
created: 2026-06-01
updated: 2026-06-01
difficulty: intermediate
source: "FPGA代码规范(deepseek使用)_transformer优化v1.2.pdf"
---

# FPGA 代码规范

## 概述

本文档定义了 FPGA 开发中的代码规范，确保代码质量和可维护性。

---

## 命名规范

### 1. 信号命名

| 类型 | 前缀/后缀 | 示例 |
|------|-----------|------|
| **时钟** | `clk_` | `clk_100m`, `clk_cpu` |
| **复位** | `rst_n_` | `rst_n_sys` |
| **输入** | `i_` 或无前缀 | `i_data`, `data_in` |
| **输出** | `o_` 或 `_o` | `o_valid`, `valid_o` |
| **寄存器** | `r_` 或 `_d` | `r_data`, `data_d` |
| **线网** | `w_` 或无前缀 | `w_valid`, `valid` |

### 2. 模块命名

```verilog
// ✅ 推荐：小写 + 下划线
module fifo_buffer (
    ...
);

// ❌ 避免：大写或驼峰
module FifoBuffer (  // 避免
    ...
);
```

### 3. 参数命名

```verilog
// ✅ 推荐：大写 + 下划线
parameter DATA_WIDTH = 8;
parameter ADDR_WIDTH = 4;

// ❌ 避免：小写
parameter data_width = 8;  // 避免
```

---

## 代码结构

### 1. 文件头

```verilog
=============================================================
// 文件名: module_name.v
// 描述: 模块功能描述
// 作者: 作者名
// 日期: YYYY-MM-DD
// 版本: v1.0
=============================================================
```

### 2. 模块声明

```verilog
module module_name (
    // 时钟和复位
    input  wire         clk,
    input  wire         rst_n,
    
    // 输入接口
    input  wire [7:0]   data_in,
    input  wire         valid_in,
    
    // 输出接口
    output reg  [7:0]   data_out,
    output reg          valid_out
);

// 参数定义
parameter DATA_WIDTH = 8;

// 内部信号
reg [7:0] data_reg;

// 逻辑实现
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        data_reg <= 8'b0;
        valid_out <= 1'b0;
    end else begin
        data_reg <= data_in;
        valid_out <= valid_in;
    end
end

// 输出赋值
assign data_out = data_reg;

endmodule
```

---

## 注释规范

### 1. 行内注释

```verilog
// ✅ 推荐：// 后加空格
data_out <= data_in;  // 输出赋值

// ❌ 避免：无空格
data_out <= data_in; //输出赋值
```

### 2. 块注释

```verilog
// ========================================
// 功能描述
// ========================================
always @(posedge clk) begin
    // 逻辑说明
    if (enable)
        data <= data_in;
end
```

### 3. 关键逻辑注释

```verilog
// 跨时钟域同步器
reg [1:0] sync_reg;
always @(posedge clk_dst) begin
    sync_reg <= {sync_reg[0], data_src};
end
```

---

## 格式规范

### 1. 缩进

```verilog
// ✅ 推荐：4 空格缩进
always @(posedge clk) begin
    if (!rst_n) begin
        data <= 8'b0;
    end else begin
        data <= data_in;
    end
end

// ❌ 避免：Tab 或混合缩进
always @(posedge clk) begin
	if (!rst_n) begin  // Tab
	    data <= 8'b0;  // 混合
	end
end
```

### 2. 对齐

```verilog
// ✅ 推荐：信号对齐
wire [7:0]  data_in;
wire [7:0]  data_out;
wire        valid_in;
wire        valid_out;

// ❌ 避免：不对齐
wire [7:0] data_in;
wire [7:0] data_out;
wire valid_in;
wire valid_out;
```

### 3. 空行

```verilog
// ✅ 推荐：逻辑块之间空行
always @(posedge clk) begin
    // 第一段逻辑
end

// 空行分隔

always @(posedge clk) begin
    // 第二段逻辑
end
```

---

## 设计原则

### 1. 模块化

| 原则 | 说明 |
|------|------|
| **单一职责** | 一个模块只做一件事 |
| **接口清晰** | 输入输出明确 |
| **参数化** | 使用 parameter 增加灵活性 |
| **可复用** | 设计通用模块 |

### 2. 时序设计

| 原则 | 说明 |
|------|------|
| **同步设计** | 使用同步时钟 |
| **非阻塞赋值** | 时序逻辑用 `<=` |
| **避免门控时钟** | 使用使能信号 |
| **复位策略** | 最小化复位范围 |

### 3. 资源优化

| 原则 | 说明 |
|------|------|
| **资源共享** | 复用运算单元 |
| **流水线** | 提高吞吐量 |
| **状态机编码** | 独热码或二进制 |
| **位宽优化** | 使用合适的位宽 |

---

## 代码审查清单

### 命名和格式
- [ ] 信号命名符合规范
- [ ] 模块命名清晰
- [ ] 缩进一致（4 空格）
- [ ] 注释充分

### 逻辑设计
- [ ] 使用非阻塞赋值（时序逻辑）
- [ ] 使用 `always @(*)`（组合逻辑）
- [ ] 添加 default 分支
- [ ] 避免锁存器推断

### 时序设计
- [ ] 同步设计
- [ ] 复位策略合理
- [ ] 跨时钟域处理

### 资源优化
- [ ] 资源共享
- [ ] 位宽优化
- [ ] 流水线设计

---

## 常见错误

| 错误 | 正确做法 |
|------|----------|
| 混用阻塞/非阻塞 | 时序逻辑统一用非阻塞 |
| 不完整敏感列表 | 使用 `always @(*)` |
| 缺少 default | 添加 default 分支 |
| 位宽不匹配 | 显式指定位宽 |
| 命名不规范 | 遵循命名规范 |

---

## 参考资源

- [FPGA 代码规范](../../../source/datasheets/hdl-coding/)
- [Verilog 最佳实践](https://www.xilinx.com/support/documentation/)
- [项目示例](../../snippets/)
