## 二十二、RTL代码简化规范

> 专门针对Verilog/SystemVerilog RTL代码的简化规则，补充code-simplifier插件的通用简化

### 12.1 简化原则

#### 保持功能不变
- **核心原则**：简化只改变代码结构，不改变功能
- **验证方法**：简化前后Testbench结果必须一致

#### 提高可读性
- **目标**：让代码更容易理解和维护
- **方法**：减少复杂度、消除冗余、改善命名

#### 遵循规范
- **必须遵守**：时序安全规则、命名规范、代码结构
- **可以优化**：代码风格、冗余逻辑、复杂表达式

### 12.2 状态机简化

#### 合并冗余状态
```verilog
// 简化前：多个相似状态
localparam P_ST_IDLE = 3'b000;
localparam P_ST_WAIT1 = 3'b001;
localparam P_ST_WAIT2 = 3'b010;
localparam P_ST_WAIT3 = 3'b011;

// 简化后：使用计数器合并等待状态
localparam P_ST_IDLE = 2'b00;
localparam P_ST_WAIT = 2'b01;
localparam P_ST_PROC = 2'b10;
localparam P_ST_DONE = 2'b11;

reg [1:0] r_wait_cnt;
```

#### 优化状态编码
```verilog
// 简化前：二进制编码（状态多时组合逻辑复杂）
localparam P_ST_IDLE = 3'b000;
localparam P_ST_RUN  = 3'b001;
localparam P_ST_DONE = 3'b010;

// 简化后：独热码（状态多时组合逻辑简单）
localparam P_ST_IDLE = 4'b0001;
localparam P_ST_RUN  = 4'b0010;
localparam P_ST_DONE = 4'b0100;
```

### 12.3 流水线优化

#### 减少流水线级数
```verilog
// 简化前：过多流水线级数
// 第一级：输入寄存
// 第二级：预处理
// 第三级：计算1
// 第四级：计算2
// 第五级：输出寄存

// 简化后：合并相邻级
// 第一级：输入寄存 + 预处理
// 第二级：计算1 + 计算2
// 第三级：输出寄存
```

### 12.4 资源共享

#### 复用乘法器
```verilog
// 简化前：多个乘法器
wire [15:0] w_prod1 = r_a * r_b;
wire [15:0] w_prod2 = r_c * r_d;
wire [15:0] w_prod3 = r_e * r_f;

// 简化后：时分复用一个乘法器
reg [15:0] r_mult_result;
reg [1:0] r_sel;

always @(posedge i_clk_sys) begin
    case (r_sel)
        2'b00: r_mult_result <= r_a * r_b;
        2'b01: r_mult_result <= r_c * r_d;
        2'b10: r_mult_result <= r_e * r_f;
    endcase
end
```

### 12.5 逻辑优化

#### 简化条件表达式
```verilog
// 简化前：复杂的条件表达式
if (r_state == P_ST_IDLE && ri_valid && ri_ready && !ri_error && ri_data != 0) begin
    // ...
end

// 简化后：提取条件为信号
wire w_can_start = (r_state == P_ST_IDLE) && ri_valid && ri_ready && !ri_error && (ri_data != 0);

if (w_can_start) begin
    // ...
end
```

### 12.6 代码结构优化

#### 提取公共逻辑
```verilog
// 简化前：重复的逻辑
always @(posedge i_clk_sys) begin
    if (r_sel_a) begin
        r_result <= r_a * r_b + r_c;
    end else begin
        r_result <= r_d * r_e + r_f;
    end
end

// 简化后：提取公共计算
wire [15:0] w_mult = r_sel_a ? (r_a * r_b) : (r_d * r_e);
wire [7:0] w_add = r_sel_a ? r_c : r_f;

always @(posedge i_clk_sys) begin
    r_result <= w_mult + w_add;
end
```

### 12.7 简化检查清单

#### 简化前检查
- [ ] 理解当前代码功能
- [ ] 确认简化目标
- [ ] 备份当前代码
- [ ] 准备Testbench验证

#### 简化后检查
- [ ] 功能是否保持不变？
- [ ] Testbench是否通过？
- [ ] 时序是否满足要求？
- [ ] 资源使用是否优化？
- [ ] 代码可读性是否提高？

---

## 二十三、参考资料
