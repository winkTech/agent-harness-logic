---
title: "DDR MIG 与 Chip2Chip 设计指南"
domain: fpga
tags: [ddr, mig, chip2chip, memory, interface, xilinx]
created: 2026-06-06
updated: 2026-06-06
difficulty: advanced
---

# DDR MIG 与 Chip2Chip 设计指南

> Xilinx FPGA DDR 内存接口 — MIG IP 配置、时序收敛、调试方法，以及 Chip2Chip 片间互联。

---

## 一、DDR 内存接口概述

### 1.1 FPGA DDR 接口层级

```
FPGA 内部逻辑           MIG IP                 PCB               DDR 器件
┌──────────────┐    ┌──────────────┐    ┌──────────┐    ┌──────────────┐
│ 用户逻辑      │    │ MIG 控制器   │    │ PCB 布线 │    │ DDR3/DDR4   │
│ (AXI/UI)     │───▶│ ├─ 命令通路  │───▶│ 飞越拓扑  │───▶│ ┌──────────┐ │
│              │    │ ├─ 数据通路  │    │ T 型拓扑  │    │ │ Bank 0   │ │
│ ┌──────────┐ │    │ ├─ 校准引擎  │    │ Daisy链   │    │ │ Bank 1   │ │
│ │ 读写控制器│ │    │ └─ PHY      │    └──────────┘    │ └──────────┘ │
│ └──────────┘ │    └──────────────┘                     └──────────────┘
└──────────────┘
```

### 1.2 DDR 技术选型

| 特性 | DDR3 | DDR4 | DDR5 | LPDDR4 |
|:----|:----:|:----:|:----:|:------:|
| 数据速率 (Mbps) | 800-2133 | 1600-3200 | 4800-6400 | 3200-4266 |
| 电压 (V) | 1.5 | 1.2 | 1.1 | 1.1 |
| Bank 数 | 8 | 16 | 32 | 8 |
| 预取 (bit) | 8n | 8n | 16n | 8n |
| FPGA 支持 | 7-series+ | UltraScale+ | Versal | Zynq MPSoC |
| MIG 版本 | 7-series | UltraScale | — | PS 内置 |
| PCB 复杂度 | 低 | 中 | 高 | 中 |
| 功耗 (对比) | 基准 | -30% | -40% | -50% |

**选型建议**:
- 中低速 (< 1600 Mbps): DDR3 (成本最低)
- 主流 (1600-2400 Mbps): DDR4 (最佳性价比)
- 超高速 (> 3200 Mbps): DDR5 或 HBM (代价高)
- 低功耗场景: LPDDR4 (但需 MPSoC 内置控制器)

---

## 二、MIG IP 配置指南

### 2.1 MIG 配置流程

在 Vivado IP Catalog 中添加 MIG IP，关键配置项:

**Step 1: 存储器选择**
- 选择 DDR3/DDR4/LPDDR4
- 选择目标器件型号和速度等级
- **关键**: 必须与 PCB 上实际焊接的 DDR 颗粒完全匹配

**Step 2: 控制器选项**

| 参数 | 典型值 | 影响 |
|:-----|:------|:-----|
| Clock Period (ps) | 833 (1200 MHz DDR3) | 决定内存运行频率 |
| Burst Length | 8 (固定 DDR3), 8/16 (DDR4) | 影响吞吐 |
| Ordering | Normal / Strict | Normal 更高性能 |
| Bank Machine Count | 2~6 | 越多并发越高，面积越大 |

**Step 3: 地址映射**

```
Row Address Width:  15 (4Gb) / 16 (8Gb)
Column Address Width: 10
Bank Address Width: 3 (8 bank) / 2 (4 bank)

地址映射策略:
┌─────────┬─────────┬─────────┬──────────┐
│ Row     │ Bank    │ Column  │ Byte     │  ← AXI 地址
└─────────┴─────────┴─────────┴──────────┘

可选映射:
- AXI: Row-Bank-Column (效率最高, 连续访问)
- AXI: Bank-Row-Column (适用于多通道切换)
- UI: 固定映射 (MIG 自动选择)
```

**Step 4: PHY 选项**

| 参数 | 说明 | 建议 |
|:-----|:-----|:-----|
| DQ Width | 数据总线宽度 (8/16/32/64) | 匹配 DDR 颗粒位宽 |
| DQS # | DQS 使能 | 必须启用 |
| CK Width | 时钟对数量 | 自动 |
| Ordering | Byte 顺序 | 匹配 PCB 布线 |
| IO Power Mode | HIGH/LOW | 高频 > 1600 Mbps 选 HIGH |

**Step 5: 校准选项**

```tcl
# 推荐校准配置
set_property CONFIG.VREF_INTERNAL_DISABLE false [get_ips ddr4_mig]
# 内部 VREF 生成 (减少外部元件)
set_property CONFIG.READ_TERMINATION 60 [get_ips ddr4_mig]
# 读取端接电阻 60Ω (匹配常用 DDR4 设置)
```

### 2.2 关键时序参数

```tcl
# MIG 生成约束文件示例 (mig_example.xdc)
# DDR 时钟约束
create_clock -period 3.333 -name sys_clk [get_ports sys_clk_p]

# 生成时钟约束 (MIG 内部 PLL 输出)
create_generated_clock -name clk_mem \
    -source [get_pins mig_inst/u_pll/CLKOUT0] \
    -divide_by 4 -multiply_by 10 \
    [get_pins mig_inst/u_pll/CLKOUT0]

# 输入延迟约束 (DQS 相对于 CK)
# MIG 自动生成, 一般在 mig.xdc 中
# 检查约束完整性:
check_timing -verbose | grep "unconstrained"
# 确认无未约束的 DDR 路径
```

### 2.3 MIG 生成文件结构

```
ddr4_mig/                        ← MIG IP 输出目录
├── ddr4_mig.xci                 ← IP 配置 (Vivado)
├── ddr4_mig_ooc.xdc             ← 外部时序约束
├── ddr4_mig_ooc.sdc             ← 时序约束
├── ddr4_mig_Example_top.v       ← 示例顶层
├── ddr4_mig_Example_top.veo     ← 例化模板
├── ddr4_mig/user_design/        ← 用户设计目录
│   ├── rtl/                     ← MIG 控制器 RTL
│   ├── constr/                  ← 约束文件
│   └── sim/                     ← 仿真模型
├── ddr4_mig/rtl/                ← PHY 层 RTL
├── ddr4_mig/sim/                ← 仿真文件
└── ddr4_mig/tb/                 ← 示例 testbench
```

---

## 三、接口协议

### 3.1 AXI4 接口 (推荐)

MIG 提供 AXI4 从接口，是最常用的访问方式:

```verilog
// AXI4 接口例化模板
ddr4_mig u_ddr (
    // 系统接口
    .sys_clk_p   (sys_clk_p),
    .sys_clk_n   (sys_clk_n),
    .sys_rst     (sys_rst_n),
    
    // AXI4 从接口
    .s_axi_awid      (axi_awid),
    .s_axi_awaddr    (axi_awaddr),
    .s_axi_awlen     (axi_awlen),       // burst 长度 (0-255)
    .s_axi_awsize    (axi_awsize),       // burst 大小 (2/4/8)
    .s_axi_awburst   (axi_awburst),      // burst 类型 (FIXED/INCR/WRAP)
    .s_axi_awlock    (axi_awlock),       // 锁类型
    .s_axi_awcache   (axi_awcache),      // cache 类型
    .s_axi_awprot    (axi_awprot),       // 保护类型
    .s_axi_awqos     (axi_awqos),        // QoS 优先级
    .s_axi_awvalid   (axi_awvalid),
    .s_axi_awready   (axi_awready),
    
    .s_axi_wdata     (axi_wdata),        // 写数据
    .s_axi_wstrb     (axi_wstrb),        // 字节使能
    .s_axi_wlast     (axi_wlast),        // burst 最后一拍
    .s_axi_wvalid    (axi_wvalid),
    .s_axi_wready    (axi_wready),
    
    .s_axi_bid       (axi_bid),          // 写响应
    .s_axi_bresp     (axi_bresp),
    .s_axi_bvalid    (axi_bvalid),
    .s_axi_bready    (axi_bready),
    
    .s_axi_arid      (axi_arid),
    .s_axi_araddr    (axi_araddr),
    .s_axi_arlen     (axi_arlen),
    .s_axi_arsize    (axi_arsize),
    .s_axi_arburst   (axi_arburst),
    .s_axi_arlock    (axi_arlock),
    .s_axi_arcache   (axi_arcache),
    .s_axi_arprot    (axi_arprot),
    .s_axi_arqos     (axi_arqos),
    .s_axi_arvalid   (axi_arvalid),
    .s_axi_arready   (axi_arready),
    
    .s_axi_rid       (axi_rid),
    .s_axi_rdata     (axi_rdata),        // 读数据
    .s_axi_rresp     (axi_rresp),
    .s_axi_rlast     (axi_rlast),        // 最后一拍
    .s_axi_rvalid    (axi_rvalid),
    .s_axi_rready    (axi_rready),
    
    // DDR 物理接口
    .ddr4_adr        (ddr4_adr),
    .ddr4_ba         (ddr4_ba),
    .ddr4_cke        (ddr4_cke),
    .ddr4_cs_n       (ddr4_cs_n),
    .ddr4_dq         (ddr4_dq),
    .ddr4_dqs_p      (ddr4_dqs_p),
    .ddr4_dqs_n      (ddr4_dqs_n),
    .ddr4_ck_p       (ddr4_ck_p),
    .ddr4_ck_n       (ddr4_ck_n),
    
    // 初始化完成标志
    .init_calib_complete (ddr_ready)     // 校准完成 → DDR 可用
);
```

### 3.2 用户接口 (UI)

MIG 还提供简化 Native 接口 (兼容 7-series MIG):

```verilog
// UI 接口 — 更简单的控制
wire            ui_clk;              // 用户时钟 (MIG 输出)
wire            ui_clk_sync_rst;     // 用户复位
wire            init_calib_complete; // 校准完成
wire [27:0]     app_addr;            // 读写地址
wire [2:0]      app_cmd;             // 000=写, 001=读
wire            app_en;              // 命令有效
wire            app_rdy;             // 命令就绪
wire [127:0]    app_wdf_data;        // 写数据
wire            app_wdf_end;         // 写结束
wire            app_wdf_wren;        // 写使能
wire            app_wdf_rdy;         // 写就绪
wire [127:0]    app_rd_data;         // 读数据
wire            app_rd_data_end;     // 读结束
wire            app_rd_data_valid;   // 读有效
wire            app_rdy;             // 命令就绪
```

UI vs AXI4 选择:

| 特性 | AXI4 | UI (Native) |
|:----|:----:|:-----------:|
| 标准化 | 是 (广泛支持) | 否 (MIG 专有) |
| Burst 支持 | 1-256 | 固定 2/4/8 |
| 并发访问 | 多 ID 并发 | 单通道 |
| 学习成本 | 高 | 低 |
| 性能 (随机访问) | 高 | 中 |
| 兼容性 | AXI 互连 | 仅 MIG |

---

## 四、读写控制器设计

### 4.1 基本读/写状态机

```verilog
// DDR 读写控制器 (AXI4 简化版)
module ddr_ctrl #(
    parameter ADDR_WIDTH = 32,
    parameter DATA_WIDTH = 256,
    parameter BURST_LEN  = 8
) (
    input  clk,
    input  rst_n,
    
    // 用户命令
    input            cmd_valid,
    output           cmd_ready,
    input  [ADDR_WIDTH-1:0] cmd_addr,
    input            cmd_write,   // 1=写, 0=读
    input  [DATA_WIDTH-1:0] wr_data,
    output [DATA_WIDTH-1:0] rd_data,
    output           rd_valid,
    
    // AXI4 主接口 (到 MIG)
    output [3:0]     m_axi_awid,
    output [ADDR_WIDTH-1:0] m_axi_awaddr,
    output [7:0]     m_axi_awlen,
    output [2:0]     m_axi_awsize,
    output           m_axi_awvalid,
    input            m_axi_awready,
    output [DATA_WIDTH-1:0] m_axi_wdata,
    output           m_axi_wlast,
    output           m_axi_wvalid,
    input            m_axi_wready,
    input  [1:0]     m_axi_bresp,
    input            m_axi_bvalid,
    output           m_axi_bready,
    output [3:0]     m_axi_arid,
    output [ADDR_WIDTH-1:0] m_axi_araddr,
    output [7:0]     m_axi_arlen,
    output [2:0]     m_axi_arsize,
    output           m_axi_arvalid,
    input            m_axi_arready,
    input  [DATA_WIDTH-1:0] m_axi_rdata,
    input            m_axi_rlast,
    input            m_axi_rvalid,
    output           m_axi_rready
);
    typedef enum {IDLE, WRITE_ADDR, WRITE_DATA, WAIT_RESP, READ_ADDR, READ_DATA} state_t;
    state_t state, next_state;
    
    // 写 burst: 发送地址 + 数据 → 等待响应
    // 读 burst: 发送地址 → 接收数据
    
    assign m_axi_awlen  = BURST_LEN - 1;
    assign m_axi_arsize = $clog2(DATA_WIDTH/8);  // 按字节
    
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            state <= IDLE;
        end else begin
            state <= next_state;
        end
    end
    
    always_comb begin
        next_state = state;
        case (state)
            IDLE: if (cmd_valid) begin
                next_state = cmd_write ? WRITE_ADDR : READ_ADDR;
            end
            WRITE_ADDR: if (m_axi_awready) begin
                next_state = WRITE_DATA;
            end
            WRITE_DATA: if (m_axi_wready && m_axi_wlast) begin
                next_state = WAIT_RESP;
            end
            WAIT_RESP: if (m_axi_bvalid) begin
                next_state = IDLE;
            end
            READ_ADDR: if (m_axi_arready) begin
                next_state = READ_DATA;
            end
            READ_DATA: if (m_axi_rvalid && m_axi_rlast) begin
                next_state = IDLE;
            end
        endcase
    end
    
    // 输出逻辑 (略 — 标准 AXI4 握手)
endmodule
```

### 4.2 带宽计算

```
理论带宽 = 时钟频率 × 数据位宽 × 2 (DDR 双边沿)

实际带宽 = 理论带宽 × 效率

┌──────────────┬──────────┬───────┬──────────┬──────────┐
│ DDR 类型      │ 频率 MHz │ 位宽  │ 理论 GB/s│ 典型效率 │
├──────────────┼──────────┼───────┼──────────┼──────────┤
│ DDR3-1600    │ 800      │ 64    │ 12.8     │ 60-75%   │
│ DDR3-1866    │ 933      │ 64    │ 14.9     │ 60-75%   │
│ DDR4-2400    │ 1200     │ 64    │ 19.2     │ 65-80%   │
│ DDR4-3200    │ 1600     │ 64    │ 25.6     │ 65-80%   │
│ DDR5-4800    │ 2400     │ 64    │ 38.4     │ 70-85%   │
│ HBM2e        │ 1000     │ 1024  │ 256      │ 70-85%   │
└──────────────┴──────────┴───────┴──────────┴──────────┘

效率损失因素:
- 刷新周期: ~3% (DDR4 tREFI=7.8μs)
- 读写切换: 5-15% (取决于 access pattern)
- 行激活/预充电: 5-20% (非连续访问)
- 命令/数据通道仲裁: 2-5%

优化策略:
1. 大 burst 访问 (burst len = 8 或 16)
2. 读写分离 (减少切换开销)
3. 使用 Bank Machine 并发 (增加 bank 数)
4. Address mapping 优化 (匹配实际访问模式)
```

---

## 五、时序收敛

### 5.1 DDR 接口时序特殊性

DDR 接口是 FPGA 中**最严格的时序域**之一:

- 数据速率高 (1600~3200 Mbps)
- DQS/DQ 需要 bit 对齐
- DLL 校准窗口有限
- 工艺角影响大 (温度/电压)

### 5.2 MIG 时序签收检查清单

```tcl
# MIG 时序签收 — 必须在综合/实现后逐一确认

# 1. DDR 物理层时序 (由 MIG 自动约束)
report_timing -of [get_pins -hier -filter {REF_PIN_NAME =~ DQ*}] \
    -delay_type min_max -nworst 10

# 2. 用户逻辑到 MIG 接口时序
# AXI4 接口通常半速运行 (UI_CLK = 1/2 MEM_CLK)
report_timing -of [get_cells -hier -filter {NAME =~ *ddr_ctrl*}] \
    -delay_type setup -nworst 5

# 3. 读数据眼图检查
# 如果有 IBERT 或 MIG 调试端口:
report_ddr_eye_scan -pll_lock_wait 100
# 输出: 每个 DQ bit 的眼图宽度

# 4. 检查校准状态
# init_calib_complete 必须拉高
# 若未拉高 → 检查 DDR 硬件连接/时序
```

### 5.3 MIG 时序问题诊断

| 症状 | 可能原因 | 诊断方法 | 解决 |
|:-----|:---------|:---------|:-----|
| `init_calib_complete` 不拉高 | 硬件连接/Bank 电压 | 检查 DDR 供电、VREF | 修复 PCB 问题 |
| 偶发读错误 | 建立/保持时间不足 | `report_ddr_eye_scan` | 调整 DQS 相位 |
| 部分地址不可用 | Row/Column 配置错误 | 核对 DDR 颗粒 datasheet | 修改 MIG 配置 |
| 高温时出错 | 温度漂移 | 温箱测试 + 眼图监测 | 增加刷新率 |
| 写错误 | DQ/DQS 偏斜 | `report_ddr_eye_scan -type write` | 调整 DQ 延迟 |
| 低效率 | Bank 冲突 | AXI 监控 trace | 优化地址映射 |

---

## 六、调试方法

### 6.1 MIG 调试流程

```
问题: DDR 读写错误
    │
    ├── Step 1: 硬件检查
    │   ├─ DDR 供电 (VDD/VDDQ/VPP/VREF) — 万用表测量
    │   ├─ 时钟信号 (差分幅度 ≥ 500mVpp) — 示波器
    │   └─ 复位时序 (POWER_GOOD 顺序)
    │
    ├── Step 2: MIG 校准状态
    │   ├─ init_calib_complete 是否拉高?
    │   ├─ 若未拉高: 检查 calib_done 信号链
    │   └─ 检查 MIG 状态寄存器 (debug 端口)
    │
    ├── Step 3: 简单读写测试
    │   ├─ 写入固定模式 (0x5A5A5A5A / 0xA5A5A5A5)
    │   ├─ 读回并与写入值对比
    │   └─ 逐地址扫描 (0~MAX_ADDR)
    │
    ├── Step 4: 压力测试
    │   ├─ 随机地址 + 随机数据 + 随机 burst 长度
    │   ├─ 多 Bank 并发访问
    │   └─ 温循: -40°C ~ +85°C
    │
    └── Step 5: 眼图分析
        ├─ report_ddr_eye_scan
        └─ 调整写入/读取延迟
```

### 6.2 ILA 调试

```tcl
# 在 MIG 的 AXI4 接口添加 ILA
create_debug_core u_ila_ddr ila
set_property C_DATA_DEPTH 16384 [get_debug_cores u_ila_ddr]
set_property C_TRIGIN_EN false [get_debug_cores u_ila_ddr]

# 添加 AXI4 写通道探头
debug_add_probe -core u_ila_ddr [get_nets axi_awaddr]
debug_add_probe -core u_ila_ddr [get_nets axi_wdata]
debug_add_probe -core u_ila_ddr [get_nets axi_wvalid]
debug_add_probe -core u_ila_ddr [get_nets axi_wready]
debug_add_probe -core u_ila_ddr [get_nets axi_bvalid]
debug_add_probe -core u_ila_ddr [get_nets axi_bresp]

# 读通道
debug_add_probe -core u_ila_ddr [get_nets axi_araddr]
debug_add_probe -core u_ila_ddr [get_nets axi_rdata]
debug_add_probe -core u_ila_ddr [get_nets axi_rvalid]

# 校准状态
debug_add_probe -core u_ila_ddr [get_nets init_calib_complete]

# 连接 debug core
set_property CONROL_PORT_MODE false [get_debug_cores u_ila_ddr]
create_debug_port u_ila_ddr write
connect_debug_port u_ila_ddr/write [get_nets ...]
```

### 6.3 DDR 测试程序 (Verilog)

```verilog
// DDR BIST (Built-In Self-Test) — 内存完整性测试
module ddr_bist #(
    parameter ADDR_WIDTH = 27,
    parameter DATA_WIDTH = 256,
    parameter TEST_DEPTH = 1024   // 测试深度 (words)
) (
    input  clk,
    input  rst_n,
    input  start,
    output reg done,
    output reg pass,
    output reg [31:0] error_count,
    
    // DDR 控制器接口
    output reg          cmd_valid,
    input               cmd_ready,
    output reg [ADDR_WIDTH-1:0] cmd_addr,
    output reg          cmd_write,
    output reg [DATA_WIDTH-1:0] wr_data,
    input  [DATA_WIDTH-1:0] rd_data,
    input               rd_valid
);

    typedef enum {IDLE, WRITE_ALL, READ_ALL, DONE_STATE} state_t;
    state_t state;
    reg [ADDR_WIDTH-1:0] addr_counter;
    reg [31:0] data_gen;
    
    // PRBS-15 数据生成
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            data_gen <= 32'h1;
        end else begin
            data_gen <= {data_gen[30:0], data_gen[14] ^ data_gen[13]};
        end
    end
    
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            state <= IDLE;
            done <= 0;
            pass <= 0;
            error_count <= 0;
            addr_counter <= 0;
        end else begin
            case (state)
                IDLE: if (start) begin
                    state <= WRITE_ALL;
                    addr_counter <= 0;
                    error_count <= 0;
                end
                
                WRITE_ALL: begin
                    if (addr_counter < TEST_DEPTH) begin
                        // 写操作
                        cmd_valid <= 1;
                        cmd_write <= 1;
                        cmd_addr <= addr_counter;
                        wr_data <= {8{data_gen}};  // 复制 PRBS
                        if (cmd_ready) begin
                            addr_counter <= addr_counter + 1;
                        end
                    end else begin
                        state <= READ_ALL;
                        addr_counter <= 0;
                    end
                end
                
                READ_ALL: begin
                    if (addr_counter < TEST_DEPTH) begin
                        cmd_valid <= 1;
                        cmd_write <= 0;
                        cmd_addr <= addr_counter;
                        if (cmd_ready) begin
                            addr_counter <= addr_counter + 1;
                        end
                        // 等待读数据返回
                        if (rd_valid) begin
                            if (rd_data !== {8{data_gen}}) begin
                                error_count <= error_count + 1;
                            end
                        end
                    end else begin
                        state <= DONE_STATE;
                    end
                end
                
                DONE_STATE: begin
                    done <= 1;
                    pass <= (error_count == 0);
                end
            endcase
        end
    end
endmodule
```

---

## 七、Chip2Chip 互联

### 7.1 Chip2Chip 概述

多芯片互联在以下场景使用:
- **带宽扩展**: 单芯片 LUT/BRAM 不够，多片 FPGA 协同
- **接口桥接**: 不同电平/协议芯片间数据桥接
- **系统拆分**: 将天线阵列处理分布到多片 FPGA

### 7.2 Chip2Chip 方案对比

| 方案 | 带宽 (per Lane) | 延迟 | 引脚数 (32Gbps) | PCB 复杂度 | 适用距离 |
|:----|:--------------:|:----:|:--------------:|:---------:|:--------:|
| **GTH/GTY** | 12.5-32 Gbps | ~50 ns | 2-4 | 高 | < 1m |
| **LVDS** | 0.5-1.5 Gbps | ~5 ns | 20-40 | 中 | < 30cm |
| **SelectMap** | 0.8-3.2 Gbps | ~10 ns | 40+ | 低 | < 15cm |
| **Aurora** | 12.5-32 Gbps | ~60 ns | 2-4 | 高 | < 1m |
| **JESD204B** | 6-12.5 Gbps | ~100 ns | 2-4 | 高 | < 1m |
| **并行总线** | 0.1-0.5 Gbps | ~3 ns | 40+ | 低 | < 10cm |

### 7.3 Chip2Chip 设计要点

```verilog
// Chip2Chip 数据同步结构
//
// Chip A (发送)                         Chip B (接收)
// ┌──────────────┐    SerDes/并行     ┌──────────────┐
// │ 用户数据     │───▶ 编码+同步 ───▶│ 解码+同步    │───▶ 用户逻辑
// │ ┌──────────┐│   ┌────────────┐   │ ┌──────────┐│
// │ │ FIFO     ││──▶│ 8B/10B 编码 │──▶│ FIFO      ││
// │ │ (异步)   ││   │ K 码插入   │   │ │ (异步)   ││
// │ └──────────┘│   │ 时钟修正  │   │ └──────────┘│
// └────────────┘    └────────────┘   └────────────┘
```

**设计要点**:

1. **时钟域同步**: 使用异步 FIFO 隔离不同芯片的时钟域
2. **数据对齐**: 插入同步字 (如 comma) 做字对齐
3. **错误检测**: CRC/奇偶校验 + 重传机制
4. **反压管理**: 接收端 FIFO 满时通知发送端暂停
5. **初始化**: 链路训练 + 握手协议

```verilog
// Chip2Chip 帧结构
//
// ┌──────┬──────┬──────┬──────┬──────┬──────┐
// │ K28.5│ K28.0│ 数据0│ 数据1│ CRC  │ K28.5│ ← 8B/10B 编码
// │ COM  │ SOP  │      │      │      │ COM  │
// └──────┴──────┴──────┴──────┴──────┴──────┘
//  帧头   帧起始   有效数据  校验   帧尾
```

### 7.4 DDR Chip2Chip 共享内存

多芯片通过共享 DDR 通信:

```
Chip A                共享 DDR                  Chip B
┌────────┐          ┌──────────┐          ┌────────┐
│ 写控制器 │────────▶│  DDR 内存  │◀────────│ 读控制器 │
│         │         │ ┌──────┐ │         │         │
│ Ring    │         │ │ 共享  │ │         │ Ring    │
│ Buffer  │         │ │ 缓冲  │ │         │ Buffer  │
│ 生产者  │         │ └──────┘ │         │ 消费者  │
└────────┘         └──────────┘         └────────┘

同步机制:
1. Chip A 写 DDR + 写标志寄存器 (GPIO/SPI)
2. Chip B 轮询标志寄存器
3. Chip B 读取 DDR 数据
4. 完成后清除标志

限制:
- 延迟高 (通过外部 DDR 读写 ~100 ns)
- 带宽受限于 DDR 控制器
- 需要外部同步机制
```

---

## 八、常见问题

| 问题 | 原因 | 解决方案 |
|:-----|:-----|:---------|
| MIG 校准失败 | DDR 硬件连接错误 | 检查供电、时钟、DQ 分配 |
| 偶发数据错误 | DQS 相位偏斜 | 调整 PHY 延迟 |
| DDR 效率低 | Bank 冲突 | 优化地址映射 + 增加 bank 数 |
| MIG 时序不收敛 | 用户逻辑离 MIG 太远 | 约束布局到 MIG 附近 |
| AXI 接口 deadlock | 读/写 interleave 处理不当 | 确保 rready 始终拉高 |
| Chip2Chip 丢数据 | 时钟域同步不足 | 加异步 FIFO + CRC |
| MIG 仿真与硬件不一致 | 仿真模型不匹配 | 使用 MIG 提供的仿真模型 |
| 高温下 DDR 错误 | 温度漂移超出校准范围 | 增加刷新率 + 在线校准 |

---

## 参考

| 资源 | 说明 |
|:----|:-----|
| [PCIe 设计指南](./pcie-guide.md) | PCIe DMA 与 AXI 互联 |
| [Aurora 设计指南](./aurora-guide.md) | Aurora 高速串行协议 |
| [JESD204B 设计指南](./jesd204b-guide.md) | JESD204B 与 RFSoC 接口 |
| [SelectMap 配置指南](./selectmap-guide.md) | 多芯片配置拓扑 |
| UG586 (MIG 7-series) | 7-series MIG 用户指南 |
| UG150 (UltraScale MIG) | UltraScale MIG 用户指南 |
| UG1085 (RFSoC TRM) | RFSoC DDR 控制器章节 |
| 时序收敛指南 | [./timing-convergence-cases.md](./timing-convergence-cases.md) |
