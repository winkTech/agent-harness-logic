# FPGA开发指南

> 基于Vivado开发、AXI接口、功耗优化等FPGA特定主题整理

---

## 一、Vivado开发流程

### 1.1 项目创建与管理

```tcl
# 创建项目
create_project my_project ./my_project -part xc7z020clg400-1

# 添加源文件
add_files -norecurse ./src/module1.v ./src/module2.v

# 设置顶层模块
set_property top my_top [current_fileset]

# 运行综合
synth_design -top my_top -part xc7z020clg400-1

# 运行实现
place_design
route_design

# 生成比特流
write_bitstream -force ./output/my_project.bit
```

### 1.2 约束文件（XDC）

```tcl
# 时钟约束
create_clock -period 10.000 -name sys_clk [get_ports clk]

# 输入延迟
set_input_delay -clock sys_clk -max 5.0 [get_ports {data_in[*]}]

# 输出延迟
set_output_delay -clock sys_clk -max 3.0 [get_ports {data_out[*]}]

# 虚假路径
set_false_path -from [get_ports reset] -to [get_clocks sys_clk]

# 多周期路径
set_multicycle_path 2 -setup -from [get_cells reg_a] -to [get_cells reg_b]
```

### 1.3 时序分析

```tcl
# 查看时序报告
report_timing_summary -file ./reports/timing_summary.rpt

# 查看特定路径
report_timing -from [get_cells reg_a] -to [get_cells reg_b] -max_paths 10

# 查看违例
report_timing -sort_by slack -max_paths 20
```

---

## 二、AXI接口设计

### 2.1 AXI4-Lite接口

```verilog
// AXI4-Lite从机接口
module axi4_lite_slave #(
    parameter C_S_AXI_DATA_WIDTH = 32,
    parameter C_S_AXI_ADDR_WIDTH = 4
)(
    // AXI4-Lite接口
    input  wire                          S_AXI_ACLK,
    input  wire                          S_AXI_ARESETN,
    input  wire [C_S_AXI_ADDR_WIDTH-1:0] S_AXI_AWADDR,
    input  wire [2:0]                    S_AXI_AWPROT,
    input  wire                          S_AXI_AWVALID,
    output wire                          S_AXI_AWREADY,
    input  wire [C_S_AXI_DATA_WIDTH-1:0] S_AXI_WDATA,
    input  wire [(C_S_AXI_DATA_WIDTH/8)-1:0] S_AXI_WSTRB,
    input  wire                          S_AXI_WVALID,
    output wire                          S_AXI_WREADY,
    output wire [1:0]                    S_AXI_BRESP,
    output wire                          S_AXI_BVALID,
    input  wire                          S_AXI_BREADY,
    input  wire [C_S_AXI_ADDR_WIDTH-1:0] S_AXI_ARADDR,
    input  wire [2:0]                    S_AXI_ARPROT,
    input  wire                          S_AXI_ARVALID,
    output wire                          S_AXI_ARREADY,
    output wire [C_S_AXI_DATA_WIDTH-1:0] S_AXI_RDATA,
    output wire [1:0]                    S_AXI_RRESP,
    output wire                          S_AXI_RVALID,
    input  wire                          S_AXI_RREADY
);

// 写地址通道
always @(posedge S_AXI_ACLK) begin
    if (!S_AXI_ARESETN) begin
        S_AXI_AWREADY <= 1'b0;
    end else begin
        if (~S_AXI_AWREADY && S_AXI_AWVALID && S_AXI_WVALID) begin
            S_AXI_AWREADY <= 1'b1;
        end else begin
            S_AXI_AWREADY <= 1'b0;
        end
    end
end

// 写数据通道
always @(posedge S_AXI_ACLK) begin
    if (!S_AXI_ARESETN) begin
        S_AXI_WREADY <= 1'b0;
    end else begin
        if (~S_AXI_WREADY && S_AXI_WVALID && S_AXI_AWVALID) begin
            S_AXI_WREADY <= 1'b1;
        end else begin
            S_AXI_WREADY <= 1'b0;
        end
    end
end

endmodule
```

### 2.2 AXI4-Stream接口

```verilog
// AXI4-Stream接口
module axi4_stream_master #(
    parameter DATA_WIDTH = 64,
    parameter KEEP_WIDTH = DATA_WIDTH/8
)(
    input  wire                  ACLK,
    input  wire                  ARESETN,
    // AXI4-Stream接口
    output wire [DATA_WIDTH-1:0] TDATA,
    output wire [KEEP_WIDTH-1:0] TKEEP,
    output wire                  TVALID,
    input  wire                  TREADY,
    output wire                  TLAST
);

// 流数据传输
always @(posedge ACLK) begin
    if (!ARESETN) begin
        TVALID <= 1'b0;
    end else begin
        if (data_available && TREADY) begin
            TVALID <= 1'b1;
            TDATA <= data_out;
            TLAST <= last_transfer;
        end else begin
            TVALID <= 1'b0;
        end
    end
end

endmodule
```

---

## 三、功耗优化

### 3.1 时钟门控

```verilog
// 时钟门控模块
module clock_gating (
    input  wire clk_in,
    input  wire enable,
    output wire clk_out
);

reg r_enable;

always @(posedge clk_in) begin
    r_enable <= enable;
end

assign clk_out = clk_in & r_enable;

endmodule
```

### 3.2 低功耗设计原则

- **减少时钟翻转**：使用时钟使能信号
- **门控时钟**：对不使用的模块关闭时钟
- **电源门控**：关闭不使用的电源域
- **电压调节**：根据性能需求调整电压

### 3.3 Vivado功耗分析

```tcl
# 运行功耗分析
report_power -file ./reports/power_report.rpt

# 设置功耗约束
set_power_opt -exclude_leaf_cells [get_cells -hierarchical -filter {PRIMITIVE_TYPE == REGISTER.PRE}]

# 运行功耗优化
power_opt_design
```

---

## 四、DMA集成

### 4.1 DMA控制器配置

```verilog
// DMA控制器接口
module dma_controller #(
    parameter DATA_WIDTH = 64,
    parameter ADDR_WIDTH = 32
)(
    input  wire                  clk,
    input  wire                  resetn,
    // 控制接口
    input  wire [ADDR_WIDTH-1:0] src_addr,
    input  wire [ADDR_WIDTH-1:0] dst_addr,
    input  wire [31:0]           length,
    input  wire                  start,
    output wire                  done,
    // AXI4-Stream接口
    output wire [DATA_WIDTH-1:0] m_axis_tdata,
    output wire                  m_axis_tvalid,
    input  wire                  m_axis_tready,
    output wire                  m_axis_tlast
);

// DMA状态机
localparam IDLE = 2'b00;
localparam TRANSFER = 2'b01;
localparam DONE = 2'b10;

reg [1:0] state;
reg [31:0] byte_count;

always @(posedge clk) begin
    if (!resetn) begin
        state <= IDLE;
        byte_count <= 32'd0;
    end else begin
        case (state)
            IDLE: begin
                if (start) begin
                    state <= TRANSFER;
                    byte_count <= 32'd0;
                end
            end
            TRANSFER: begin
                if (m_axis_tvalid && m_axis_tready) begin
                    byte_count <= byte_count + 8; // DATA_WIDTH/8
                    if (byte_count >= length - 8) begin
                        state <= DONE;
                    end
                end
            end
            DONE: begin
                state <= IDLE;
            end
        endcase
    end
end

endmodule
```

### 4.2 突发传输优化

- **突发长度**：选择合适的突发长度（4/8/16/256）
- **缓冲管理**：使用FIFO缓冲数据
- **对齐传输**：确保地址对齐

---

## 五、延迟优化

### 5.1 流水线优化

```verilog
// 三级流水线乘法器
module pipeline_multiplier #(
    parameter DATA_WIDTH = 16
)(
    input  wire                  clk,
    input  wire                  resetn,
    input  wire [DATA_WIDTH-1:0] a,
    input  wire [DATA_WIDTH-1:0] b,
    output wire [2*DATA_WIDTH-1:0] result
);

reg [DATA_WIDTH-1:0] r_a_1, r_a_2;
reg [DATA_WIDTH-1:0] r_b_1, r_b_2;
reg [2*DATA_WIDTH-1:0] r_result;

always @(posedge clk) begin
    if (!resetn) begin
        r_a_1 <= 'd0; r_a_2 <= 'd0;
        r_b_1 <= 'd0; r_b_2 <= 'd0;
        r_result <= 'd0;
    end else begin
        r_a_1 <= a; r_a_2 <= r_a_1;
        r_b_1 <= b; r_b_2 <= r_b_1;
        r_result <= r_a_2 * r_b_2;
    end
end

assign result = r_result;

endmodule
```

### 5.2 延迟与吞吐量平衡

- **低延迟**：减少流水线级数
- **高吞吐量**：增加流水线级数
- **资源权衡**：根据FPGA资源选择

---

## 六、调试技术

### 6.1 ILA（集成逻辑分析仪）

```tcl
# 添加ILA核
create_debug_core u_ila_0 ila
set_property C_DATA_DEPTH 4096 [get_debug_cores u_ila_0]
set_property C_TRIGIN_EN false [get_debug_cores u_ila_0]
set_property C_TRIGOUT_EN false [get_debug_cores u_ila_0]
set_property C_INPUT_PIPE_STAGES 0 [get_debug_cores u_ila_0]

# 连接探针
connect_debug_port u_ila_0/probe0 [get_nets {data[*]}]
```

### 6.2 VIO（虚拟输入/输出）

```tcl
# 添加VIO核
create_debug_core u_vio_0 vio
set_property C_NUM_PROBE_IN 0 [get_debug_cores u_vio_0]
set_property C_NUM_PROBE_OUT 2 [get_debug_cores u_vio_0]

# 设置初始值
set_property -dict {INIT_OUT 0} [get_debug_ports u_vio_0/probe_out0]
set_property -dict {INIT_OUT 1} [get_debug_ports u_vio_0/probe_out1]
```

---

## 七、常见问题解决

### 7.1 时序违例

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| Setup违例 | 关键路径过长 | 增加流水线级数、优化逻辑 |
| Hold违例 | 路径延时过短 | 增加延迟、调整布局 |
| 时钟违例 | 时钟质量差 | 优化时钟树、使用BUFG |

### 7.2 资源不足

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| LUT不足 | 逻辑复杂 | 优化算法、使用IP核 |
| FF不足 | 寄存器过多 | 优化设计、共享寄存器 |
| BRAM不足 | 存储器过大 | 使用分布式RAM、优化存储 |

### 7.3 功耗过高

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 动态功耗高 | 时钟翻转频繁 | 使用时钟门控 |
| 静态功耗高 | 电源泄漏 | 选择低功耗器件 |
| IO功耗高 | 驱动能力过强 | 调整驱动强度 |
