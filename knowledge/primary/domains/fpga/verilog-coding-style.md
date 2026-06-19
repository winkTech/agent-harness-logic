---
name: verilog-coding-style
title: "Verilog/SystemVerilog 编码风格"
domain: fpga
tags: [verilog, systemverilog, coding-style, best-practices]
created: 2026-06-01
updated: 2026-06-01
difficulty: intermediate
sources:
  - "代码应该这样写.pdf"
  - "代码应该这样写（2-10）.pdf"
  - "SystemVerilog_用好packed array.pdf"
---

# Verilog/SystemVerilog 编码风格

## 概述

本文档总结了 Verilog/SystemVerilog 的最佳编码风格，来自"代码应该这样写"系列。

---

## 一、代码优化原则

### 1. 选择最优语句

| 写法 | 资源 | 性能 | 推荐 |
|------|------|------|------|
| if-elseif | 中 | 差 | ❌ |
| 三目运算符 | 中 | 中 | ⚠️ |
| unique case | 多 | 好 | ✅ |
| unique case + 无复位 | 少 | 最好 | ✅✅ |

### 2. 案例对比

```verilog
// ❌ 方案1: if-elseif（优先级电路）
always_ff @(posedge clk) begin
    if (rst_d1)
        dout <= '0;
    else if (vld_d1 & sop_d1)
        dout <= 16'd64;
    else if (vld_d1 & eop_d1)
        dout <= dout + din_d1;
    else if (vld_d1)
        dout <= dout + 16'd64;
end

// ✅ 方案2: unique case（MUX电路）
always_ff @(posedge clk) begin
    if (vld_d1) begin
        unique case (sel)
            2'b01: dout <= 16'd64;
            2'b10: dout <= dout + din_d1;
            2'b00: dout <= dout + 16'd64;
        endcase
    end
end
```

---

## 二、移位寄存器设计

### 问题：SRL 映射失败

**原因**：
- SRL 不支持复位
- 使用 parameter 选择电路

**解决方案**：

```verilog
// ✅ 正确：分离移位和复位
module shift_register #(
    parameter DEPTH = 4,
    parameter WIDTH = 1,
    parameter SRL_STYLE = "reg_srl_reg"
)(
    input  logic clk,
    input  logic ce,
    input  logic [WIDTH-1:0] si,
    output logic [WIDTH-1:0] so
);

(* srl_style = SRL_STYLE *)
logic [WIDTH-1:0] sreg [DEPTH] = '{default:0};

assign so = sreg[DEPTH-1];

always_ff @(posedge clk) begin
    if (ce) begin
        sreg[0] <= si;
        for (int i = 1; i < DEPTH; i++)
            sreg[i] <= sreg[i-1];
    end
end

endmodule
```

### SRL_STYLE 属性

| 值 | 结构 | 适用场景 |
|----|------|----------|
| `srl` | 纯 SRL | 资源优先 |
| `register` | 纯寄存器 | 性能优先 |
| `reg_srl` | 寄存器 + SRL | 平衡 |
| `srl_reg` | SRL + 寄存器 | 平衡 |
| `reg_srl_reg` | 寄存器 + SRL + 寄存器 | 时序优化 |

---

## 三、数据选择器（MUX）设计

### 128:1 MUX 实现方案

| 方案 | 结构 | FF | LUT | 性能 |
|------|------|----|----|------|
| 4-4-4-2 | 多级 MUX | 52 | 43 | 最好 |
| 4-2-4-4 | 多级 MUX | 64 | 53 | 好 |
| 一级 MUX | packed array | 136 | 34 | 差 |

### 推荐方案

```verilog
// ✅ 多级 MUX（4-4-4-2 结构）
module mux_128to1 (
    input  logic [127:0] din,
    input  logic [6:0]   sel,
    output logic         dout
);

// 4级流水线 MUX
// 第1级: 32个 4:1 MUX
// 第2级: 8个 4:1 MUX  
// 第3级: 2个 4:1 MUX
// 第4级: 1个 2:1 MUX

endmodule
```

---

## 四、Packed Array 使用

### 基本概念

```verilog
// Unpacked Array（不连续存储）
bit [7:0] arr1 [0:3];  // 4个独立的8位元素

// Packed Array（连续存储）
bit [1:0][3:0] bus;    // 连续的8位存储
```

### 优势

| 特性 | Unpacked | Packed |
|------|----------|--------|
| 存储 | 不连续 | 连续 |
| 整体赋值 | ❌ | ✅ |
| 部分选择 | ✅ | ✅ |
| 可综合 | ✅ | ✅ |

### 应用案例

```verilog
// ✅ 4选1 MUX 使用 packed array
module mymux #(
    parameter CW = 4,
    parameter DW = 8,
    parameter SW = $clog2(CW)
)(
    input  logic clk,
    input  logic [CW-1:0][DW-1:0] din,
    input  logic [SW-1:0] sel,
    output logic [DW-1:0] dout
);

logic [CW-1:0][DW-1:0] din_d1;
logic [SW-1:0] sel_d1;

always_ff @(posedge clk) begin
    din_d1 <= din;
    sel_d1 <= sel;
end

always_ff @(posedge clk) begin
    dout <= din_d1[sel_d1];  // 一条语句完成
end

endmodule
```

---

## 五、复位优化

### 原则

1. **最小化复位范围**
2. **同步复位优于异步复位**
3. **考虑上电初始化**
4. **避免不必要的复位**

### 案例

```verilog
// ❌ 不必要的复位
always_ff @(posedge clk) begin
    if (rst)
        dout <= '0;
    else if (vld)
        dout <= din;
end

// ✅ 移除不必要的复位
always_ff @(posedge clk) begin
    if (vld)
        dout <= din;
end
```

---

## 六、编码检查清单

### 语句选择
- [ ] 使用 unique case 替代 if-elseif
- [ ] 使用 packed array 简化 MUX
- [ ] 避免不必要的三目运算符嵌套

### 移位寄存器
- [ ] 分离移位和复位逻辑
- [ ] 使用 srl_style 属性
- [ ] 使用 generate 语句处理参数

### 复位设计
- [ ] 移除不必要的复位
- [ ] 使用同步复位
- [ ] 最小化复位范围

### 资源优化
- [ ] 共享运算单元
- [ ] 使用流水线
- [ ] 优化位宽

---

## 参考资源

- [代码应该这样写.pdf](../../../source/datasheets/verilog-sv/)
- [SystemVerilog_用好packed array.pdf](../../../source/datasheets/verilog-sv/)
- [AMD FPGA设计优化宝典.pdf](../../../source/datasheets/fpga-design/)
