---
name: riscv-fpga-guide
title: "RISC-V FPGA 嵌入式系统设计"
domain: fpga
tags: [riscv, embedded, soc, processor]
created: 2026-06-01
updated: 2026-06-01
difficulty: advanced
source: "基于FPGA与RISC-V的嵌入式系统设计.pdf"
---

# RISC-V FPGA 嵌入式系统设计

## 概述

RISC-V 是开源指令集架构，在 FPGA 上实现嵌入式系统具有灵活性和可定制性。

---

## 一、RISC-V 架构

### 核心特点

| 特点 | 说明 |
|------|------|
| **开源** | 免费使用，无需授权费 |
| **模块化** | 可扩展指令集 |
| **简洁** | 指令格式规整 |
| **高效** | 适合嵌入式应用 |

### 指令集格式

```
RV32I: 基础整数指令集（32位）
RV32M: 乘法除法扩展
RV32F: 单精度浮点扩展
RV32D: 双精度浮点扩展
RV32C: 压缩指令扩展
```

---

## 二、FPGA 实现架构

### 系统架构

```
┌─────────────────────────────────────────────┐
│                  RISC-V SoC                  │
├─────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │  CPU    │  │  Bus    │  │  Memory │    │
│  │  Core   │  │  Matrix │  │  Controller│   │
│  └─────────┘  └─────────┘  └─────────┘    │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │  UART   │  │  SPI    │  │  GPIO   │    │
│  └─────────┘  └─────────┘  └─────────┘    │
└─────────────────────────────────────────────┘
```

### 核心模块

| 模块 | 功能 |
|------|------|
| **CPU Core** | 指令执行 |
| **Bus Matrix** | 总线互联 |
| **Memory Controller** | 存储控制 |
| **UART** | 串口通信 |
| **SPI** | 外设接口 |
| **GPIO** | 通用IO |

---

## 三、CPU Core 实现

### 流水线结构

```
取指 → 译码 → 执行 → 访存 → 写回
```

### 关键模块

```verilog
// RISC-V CPU Core
module riscv_core (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [31:0] instr,
    input  wire [31:0] read_data,
    output wire [31:0] pc,
    output wire [31:0] addr,
    output wire [31:0] write_data,
    output wire        mem_read,
    output wire        mem_write
);

// 程序计数器
reg [31:0] pc_reg;

// 指令译码
wire [6:0] opcode = instr[6:0];
wire [2:0] funct3 = instr[14:12];
wire [6:0] funct7 = instr[31:25];

// 寄存器文件
reg [31:0] registers [0:31];

// ALU
reg [31:0] alu_result;

// 控制单元
// 根据 opcode 生成控制信号

endmodule
```

---

## 四、总线接口

### AXI4-Lite 接口

```verilog
// AXI4-Lite Slave 接口
module axi4_lite_slave (
    input  wire        S_AXI_ACLK,
    input  wire        S_AXI_ARESETN,
    // 写地址通道
    input  wire [31:0] S_AXI_AWADDR,
    input  wire        S_AXI_AWVALID,
    output wire        S_AXI_AWREADY,
    // 写数据通道
    input  wire [31:0] S_AXI_WDATA,
    input  wire        S_AXI_WVALID,
    output wire        S_AXI_WREADY,
    // 读地址通道
    input  wire [31:0] S_AXI_ARADDR,
    input  wire        S_AXI_ARVALID,
    output wire        S_AXI_ARREADY,
    // 读数据通道
    output wire [31:0] S_AXI_RDATA,
    output wire        S_AXI_RVALID,
    input  wire        S_AXI_RREADY
);

// 寄存器映射
// 中断控制
// 状态机实现

endmodule
```

---

## 五、存储器接口

### BRAM 控制器

```verilog
// BRAM 控制器
module bram_controller (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [31:0] addr,
    input  wire [31:0] write_data,
    input  wire        read_en,
    input  wire        write_en,
    output wire [31:0] read_data
);

// 双端口 BRAM
reg [31:0] bram [0:1023];

// 读写控制
always @(posedge clk) begin
    if (write_en)
        bram[addr[11:2]] <= write_data;
end

assign read_data = bram[addr[11:2]];

endmodule
```

---

## 六、外设接口

### UART 控制器

```verilog
// UART 控制器
module uart_controller (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [7:0]  tx_data,
    input  wire        tx_start,
    output wire        tx_busy,
    output wire        tx_pin,
    input  wire        rx_pin,
    output wire [7:0]  rx_data,
    output wire        rx_valid
);

// 波特率生成
// 发送移位寄存器
// 接收移位寄存器
// 状态机控制

endmodule
```

### SPI 控制器

```verilog
// SPI 控制器
module spi_controller (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [7:0]  tx_data,
    input  wire        tx_start,
    output wire        tx_busy,
    output wire        sclk,
    output wire        mosi,
    input  wire        miso,
    output wire [7:0]  rx_data,
    output wire        rx_valid
);

// 时钟分频
// 移位寄存器
// 模式控制（CPOL, CPHA）

endmodule
```

---

## 七、调试接口

### JTAG 接口

```verilog
// JTAG 接口
module jtag_interface (
    input  wire        tck,
    input  wire        tms,
    input  wire        tdi,
    output wire        tdo,
    output wire        trst_n
);

// TAP 控制器
// 指令寄存器
// 数据寄存器
// 调试模块

endmodule
```

### 调试功能

| 功能 | 说明 |
|------|------|
| **断点** | 代码断点、数据断点 |
| **单步** | 单指令执行 |
| **寄存器访问** | 读写寄存器 |
| **内存访问** | 读写内存 |

---

## 八、软件开发

### 开发工具链

| 工具 | 用途 |
|------|------|
| **GCC** | 编译器 |
| **GDB** | 调试器 |
| **OpenOCD** | 调试代理 |
| **Newlib** | C库 |

### 启动流程

```
复位 → 初始化堆栈 → 初始化数据段 → 跳转到 main
```

---

## 九、最佳实践

### 设计阶段
- [ ] 选择合适的 RISC-V 配置
- [ ] 规划存储器映射
- [ ] 设计总线架构

### 实现阶段
- [ ] 使用 IP Core 加速开发
- [ ] 分步验证各模块
- [ ] 编写测试程序

### 验证阶段
- [ ] 使用 GDB 调试
- [ ] 运行测试用例
- [ ] 性能分析

---

## 参考资源

- [基于FPGA与RISC-V的嵌入式系统设计.pdf](../../../archive/sources/fpga/)
- [RISC-V 官方网站](https://riscv.org/)
- [Vivado IP Catalog](https://www.xilinx.com/products/ip-integrators.html)
