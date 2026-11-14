---
name: avoid-global-reset
title: "避免全局复位的使用"
domain: fpga
tags: [reset, pitfall, timing, optimization]
created: 2026-06-01
updated: 2026-06-01
difficulty: intermediate
source: "在FPGA开发中尽量避免全局复位的使用.pdf"
---

# 避免全局复位的使用

## 概述

在 FPGA 设计中，过度使用全局复位会影响时序和资源。本文介绍如何优化复位策略。

---

## 问题分析

### 全局复位的问题

| 问题 | 影响 |
|------|------|
| **时序压力** | 复位路径长，时序难满足 |
| **资源浪费** | 占用全局布线资源 |
| **功耗增加** | 复位信号扇出大 |
| **性能下降** | 影响最大工作频率 |

### 何时需要复位

| 场景 | 是否需要复位 |
|------|--------------|
| **状态机** | ✅ 需要 |
| **计数器** | ⚠️ 视情况 |
| **数据通路** | ❌ 通常不需要 |
| **配置寄存器** | ✅ 需要 |

---

## 优化策略

### 1. 局部复位替代全局复位

```verilog
// ❌ 全局复位
module bad_example (
    input clk,
    input global_rst_n,  // 全局复位
    ...
);
always @(posedge clk or negedge global_rst_n) begin
    if (!global_rst_n)
        state <= IDLE;
    else
        state <= next_state;
end
endmodule

// ✅ 局部复位
module good_example (
    input clk,
    input local_rst_n,  // 只在需要时使用
    ...
);
always @(posedge clk) begin
    if (!local_rst_n)
        state <= IDLE;
    else
        state <= next_state;
end
endmodule
```

### 2. 同步复位优于异步复位

```verilog
// ✅ 同步复位（推荐）
always @(posedge clk) begin
    if (!rst_n)
        q <= 1'b0;
    else
        q <= d;
end

// ⚠️ 异步复位（谨慎使用）
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        q <= 1'b0;
    else
        q <= d;
end
```

### 3. 复位去抖

```verilog
// 复位同步器
reg [1:0] rst_sync;
always @(posedge clk) begin
    rst_sync <= {rst_sync[0], rst_n};
end

wire rst_n_clean = rst_sync[1];
```

---

## 最佳实践

| 实践 | 说明 |
|------|------|
| **最小化复位范围** | 只复位必要的寄存器 |
| **使用同步复位** | 时序更好预测 |
| **复位去抖** | 避免亚稳态 |
| **局部复位** | 减少扇出 |
| **上电初始化** | 利用 FPGA 初始化能力 |

---

## 检查清单

- [ ] 是否真的需要复位？
- [ ] 复位范围是否最小化？
- [ ] 是否使用同步复位？
- [ ] 复位信号是否去抖？
- [ ] 是否考虑上电初始化？

---

## 参考资源

- [Xilinx 复位指南](https://www.xilinx.com/support/documentation/)
- [在FPGA开发中尽量避免全局复位的使用](../../archive/sources/fpga/在FPGA开发中尽量避免全局复位的使用-source.md)
