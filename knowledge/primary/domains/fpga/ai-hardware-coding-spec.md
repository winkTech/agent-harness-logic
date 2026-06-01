---
title: "AI-Hardware 协同设计规范"
domain: fpga
tags: [ai, hardware, coding-spec, verilog, systemverilog]
created: 2026-06-01
updated: 2026-06-01
difficulty: intermediate
source: "FPGA代码规范(deepseek使用)_transformer优化v1.2.pdf"
---

# AI-Hardware 协同设计规范

## 概述

本文档定义了 AI 驱动的 RTL 代码生成规范，确保生成的代码符合硬件设计要求。

---

## 一、规则分级

### L0: 强制项（必须遵循）

| 规则 | 说明 |
|------|------|
| **时序安全** | 高电平同步复位、输入寄存、跨时钟域同步 |
| **协议接口** | 标准接口命名、握手信号、参数化位宽 |
| **状态机** | 三段式实现、default 分支、超时保护 |

### L1: 协议项（需确认）

| 规则 | 说明 |
|------|------|
| **命名规则** | 前缀规范、对齐规则 |
| **注释密度** | 每10行至少1个注释 |

### L2: 优化项（建议）

| 规则 | 说明 |
|------|------|
| **代码风格** | 对齐、格式 |

### L3: 可选项（可忽略）

| 规则 | 说明 |
|------|------|
| **美化模式** | 代码美化 |

---

## 二、命名规范

### 信号命名

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

### 特殊说明

- **标准接口信号**（如 AXI）不受前缀规则约束
- **使能控制的数据流**必须采用 `i_xx_data` 和 `i_xx_dvalid` 格式

---

## 三、输入输出处理

### 输入寄存原则

```verilog
// ✅ 使用 ri 前缀标记寄存后的输入信号
reg [7:0] ri_rx_data;

always @(posedge i_clk) begin
    if (i_rst)
        ri_rx_data <= 'd0;
    else
        ri_rx_data <= i_rx_data;
end
```

### 输出驱动原则

```verilog
// ✅ 使用 ro 前缀标记输出寄存器
reg [7:0] ro_data;

always @(posedge i_clk) begin
    if (i_rst)
        ro_data <= 'd0;
    else
        ro_data <= r_result;
end

// 通过 assign 语句驱动最终输出
assign o_data = ro_data;
```

---

## 四、复位规范

### 标准复位模板

```verilog
// ✅ 同步高电平复位
always @(posedge i_clk) begin
    if (i_rst) begin
        r_cnt <= 'd0;  // 必须显式初始化
    end
    else begin
        // 其他逻辑
    end
end
```

### 复位原则

- **同步复位**：使用 `@(posedge i_clk)`
- **高电平有效**：使用 `if (i_rst)`
- **显式初始化**：必须给所有寄存器赋初值

---

## 五、状态机设计

### 三段式状态机

```verilog
// 1. 状态寄存器
always @(posedge i_clk) begin
    if (i_rst)
        r_st_current <= P_ST_IDLE;
    else
        r_st_current <= r_st_next;
end

// 2. 次态逻辑（组合逻辑）
always @(*) begin
    case (r_st_current)
        P_ST_IDLE: r_st_next = (i_cmd) ? P_ST_HEAD : P_ST_IDLE;
        P_ST_HEAD: r_st_next = P_ST_HIGH;
        P_ST_HIGH: r_st_next = P_ST_LOW;
        P_ST_LOW:  r_st_next = P_ST_TAIL;
        P_ST_TAIL: r_st_next = P_ST_IDLE;
        default:   r_st_next = P_ST_IDLE;  // 必须包含 default
    endcase
end

// 3. 输出逻辑
always @(posedge i_clk) begin
    if (i_rst) begin
        ro_data <= 'd0;
        ro_valid <= 1'b0;
    end
    else begin
        case (r_st_next)  // 注意使用下一状态
            P_ST_HEAD: begin
                ro_data <= 8'h55;
                ro_valid <= 1'b1;
            end
            default: begin
                ro_data <= 'd0;
                ro_valid <= 1'b0;
            end
        endcase
    end
end
```

### 状态机原则

- **必须包含 default 分支**
- **使用下一状态逻辑**（`r_st_next`）
- **超时保护**：根据时钟频率计算阈值

---

## 六、数组处理

### 初始化原则

```verilog
// ✅ 使用 {default:'d0} 语法初始化
reg [7:0] r_data_array [0:3];

always @(posedge i_clk) begin
    if (i_rst)
        r_data_array <= '{default:'d0};  // 统一初始化
    else
        r_data_array <= w_src_array;
end
```

### 数组赋值

```verilog
// ✅ 支持整体赋值
wire [7:0] w_src_array [3:0];

always @(posedge i_clk) begin
    r_data_array <= w_src_array;  // 整体赋值
end
```

### 注意事项

- **禁止使用** `initial` 语句初始化
- **支持整体赋值**
- **复位时使用** `{default:'d0}`

---

## 七、流水线设计

### 核心原则

1. **寄存器隔离每级计算**
2. **valid 信号严格同步传递**
3. **复位清除所有流水状态**
4. **计算位宽自动扩展**

### 示例

```verilog
// 乘累加计算流水线
reg [31:0] r_pipe_ab, r_pipe_cd;
reg r_pipe1_valid;

always @(posedge i_clk) begin
    if (i_rst) begin
        {r_pipe_ab, r_pipe_cd} <= {2{32'd0}};
        r_pipe1_valid <= 1'b0;
    end
    else begin
        r_pipe_ab <= $signed(ri_a) * $signed(ri_b);
        r_pipe_cd <= $signed(ri_c) * $signed(ri_d);
        r_pipe1_valid <= ri_valid;
    end
end
```

---

## 八、代码结构顺序

### 推荐顺序

1. 模块声明和 I/O 定义
2. 输入信号寄存 (`ri_`)
3. 输出信号寄存 (`ro_`) 和 assign
4. 参数/状态定义 (`P_`)
5. 例化模块
6. 状态机实现
7. 组合逻辑
8. 时序逻辑
9. 数组赋值（放最后）

---

## 九、代码对齐规范

### 信号声明对齐

```verilog
// 位宽 / 信号名 / 分号 / 注释
reg [7:0]  r_data;   // 数据寄存器
reg        r_valid;  // 有效信号
wire [31:0] w_addr;  // 地址线
```

### 连续赋值对齐

```verilog
// 左值 / 等号 / 右值 / 分号 / 注释
assign o_data   = r_data;        // 数据输出
assign o_valid  = r_valid;       // 有效信号输出
assign o_ready  = w_ready & ~i_busy;  // 组合逻辑输出
```

---

## 十、检查清单

### L0 强制项
- [ ] 使用同步高电平复位
- [ ] 输入信号寄存 (`ri_`)
- [ ] 输出信号寄存 (`ro_`)
- [ ] 跨时钟域同步
- [ ] 状态机包含 default 分支

### L1 协议项
- [ ] 命名符合规范
- [ ] 注释充分（每10行至少1个）

### L2 优化项
- [ ] 代码对齐
- [ ] 格式规范

---

## 参考资源

- [FPGA代码规范(deepseek使用).pdf](../../../source/datasheets/coding-standards/)
- [AMD FPGA设计优化宝典.pdf](../../../source/datasheets/fpga-design/)
