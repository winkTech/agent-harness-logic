---
name: verilog-design-experience
title: "Verilog 设计经验总结"
domain: fpga
tags: [verilog, design, experience, best-practices]
created: 2026-06-01
updated: 2026-06-01
difficulty: intermediate
source: "总结的一些verilog设计经验.pdf"
---

# Verilog 设计经验总结

## 概述

本文档总结了 Verilog 设计中的常见经验和最佳实践。

---

## 核心原则

### 1. 编码风格

| 原则 | 说明 |
|------|------|
| **命名规范** | 使用有意义的变量名 |
| **注释充分** | 关键逻辑必须注释 |
| **模块化** | 功能独立，接口清晰 |
| **参数化** | 使用 parameter 增加灵活性 |

### 2. 时序设计

```verilog
// ✅ 推荐：同步复位
always @(posedge clk) begin
    if (!rst_n)
        q <= 1'b0;
    else
        q <= d;
end

// ⚠️ 谨慎：异步复位
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        q <= 1'b0;
    else
        q <= d;
end
```

### 3. 组合逻辑

```verilog
// ✅ 使用 always @(*)
always @(*) begin
    y = a & b;
end

// ❌ 避免不完整的敏感列表
always @(a) begin
    y = a & b;  // b 变化时不会触发
end
```

---

## 常见陷阱

### 陷阱 1：锁存器推断

**问题**：
```verilog
// 缺少 default 分支
always @(*) begin
    case (sel)
        2'b00: y = a;
        2'b01: y = b;
        // 缺少 default，会推断锁存器
    endcase
end
```

**解决方案**：
```verilog
always @(*) begin
    case (sel)
        2'b00: y = a;
        2'b01: y = b;
        default: y = 1'b0;  // 添加 default
    endcase
end
```

### 陷阱 2：阻塞与非阻塞混用

**问题**：
```verilog
always @(posedge clk) begin
    a = b;  // 阻塞
    c <= a;  // 非阻塞，但 a 已经变了
end
```

**解决方案**：
```verilog
// 时序逻辑统一使用非阻塞
always @(posedge clk) begin
    a <= b;
    c <= a;
end
```

### 陷阱 3：位宽不匹配

**问题**：
```verilog
wire [7:0] a;
wire [3:0] b;
assign b = a;  // 截断高位
```

**解决方案**：
```verilog
// 显式指定位宽
assign b = a[3:0];
```

---

## 优化技巧

### 1. 资源共享

```verilog
// ✅ 共享加法器
assign sum = (sel) ? (a + c) : (b + c);

// ❌ 重复加法器
assign sum1 = a + c;
assign sum2 = b + c;
assign sum = (sel) ? sum1 : sum2;
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
// 推荐：独热码（速度快）
localparam [3:0]
    S_IDLE = 4'b0001,
    S_RUN  = 4'b0010,
    S_DONE = 4'b0100;

// 二进制码（面积小）
localparam [1:0]
    S_IDLE = 2'b00,
    S_RUN  = 2'b01,
    S_DONE = 2'b10;
```

---

## 调试技巧

| 技巧 | 方法 |
|------|------|
| **波形调试** | 使用 Vivado Simulator |
| **ILA 抓取** | 在线逻辑分析仪 |
| **断点设置** | 仿真中设置断点 |
| **打印调试** | `$display` 输出信息 |

---

## 最佳实践清单

- [ ] 使用非阻塞赋值（时序逻辑）
- [ ] 使用 `always @(*)`（组合逻辑）
- [ ] 添加 default 分支
- [ ] 避免混合阻塞/非阻塞
- [ ] 使用参数化设计
- [ ] 添加充分注释
- [ ] 使用有意义的命名
- [ ] 进行代码审查

---

## 参考资源

- [Verilog 标准 (IEEE 1364)](https://ieeexplore.ieee.org/document/8299595)
- [Vivado 设计指南](https://www.xilinx.com/support/documentation/)
- [项目示例](../../snippets/)
