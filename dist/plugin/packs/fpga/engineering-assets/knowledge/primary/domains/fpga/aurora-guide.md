---
name: aurora-guide
title: "Aurora 高速接口设计指南"
domain: fpga
tags: [aurora, high-speed-io, gty, serial, protocol]
created: 2026-06-05
updated: 2026-06-05
difficulty: intermediate
---

# Aurora 高速接口设计指南

> Xilinx Aurora 协议 — FPGA↔FPGA 和 FPGA↔RFSoC 间轻量级高速串行通信。

---

## 一、Aurora 协议概述

### 1.1 什么是 Aurora

Aurora 是 Xilinx 定义的轻量级高速串行链路协议，专为 FPGA↔FPGA 或 FPGA↔ASIC 间数据流设计:
- **低开销**: 无复杂协议栈 (无 TLP、无路由)
- **低延迟**: 端到端延迟可低至数十 ns (取决于编码)
- **灵活**: 支持任意 Lane 数组合 (1~16+)
- **免费**: Aurora IP 核随 Vivado 免费授权

### 1.2 编码方案

| 变体 | 编码 | 有效带宽 | 典型速率 | 适用场景 |
|:----|:----:|:-------:|:--------:|:--------|
| Aurora 8B/10B | 8B/10B | 80% | ≤12.5 Gbps | 通用互联 |
| Aurora 64B/66B | 64B/66B | 96.9% | ≤25.8 Gbps | 高带宽需求 |

**关键差异**:
- 8B/10B: 每字节需要 10 bit 线速率，链路开销 20%
- 64B/66B: 每 64 bit 数据用 2 bit 同步头，链路开销仅 3.1%
- 8B/10B 内建 DC 平衡 (Disparity 控制)，64B/66B 用加扰替代

### 1.3 与 JESD204B / PCIe 对比

| 特性 | Aurora | JESD204B | PCIe |
|:----|:------:|:--------:|:----:|
| 协议开销 | 极低 | 中 (8B/10B + 控制字符) | 高 (TLP/DMA) |
| 延迟 | <100 ns | 确定性 (可预测) | ~μs (取决于 TLP) |
| 链路建立 | 简单 (Auto-negotiate) | 三阶段 (CGS→ILA→Data) | 复杂 (训练+协商) |
| 用户数据封装 | 原始数据流 | 帧结构 | TLP+Payload |
| FPGA 资源 | 少 | 中 | 多 |
| 适用距离 | 背板/短距 (≤1m) | PCB (≤10") | 扩展槽/线缆 |

---

## 二、IP 核配置

### 2.1 Aurora 8B/10B 配置

Vivado IP Catalog → **Aurora 8B/10B**:

| 参数 | 典型值 | 说明 |
|:----|:------|:-----|
| Line Rate | 6.25 Gbps | 取决于 GTY/GTH 能力 |
| GT Refclk | 312.5 MHz | 线速率 / 20 (8B/10B) |
| Lane Width | 4 | 数据宽度单位 |
| Dataflow Mode | Duplex | 双工模式推荐 |
| Interface | Framing / Streaming | 帧模式/流模式 |
| Flow Control | Native / UFIFO / None | 流控模式 |

### 2.2 Aurora 64B/66B 配置

Vivado IP Catalog → **Aurora 64B/66B**:

| 参数 | 典型值 | 说明 |
|:----|:------|:-----|
| Line Rate | 25.8 Gbps | 需 GTY 支持 (UltraScale+) |
| GT Refclk | 322.265625 MHz | 线速率 / 80 (64B/66B × 同步头) |
| GT Type | GTH / GTY | GTY 支持更高速率 |
| Flow Control | None / FC | 64B/66B 通常无流控 |

### 2.3 时钟架构

```
外部参考时钟 (100/125/312.5 MHz)
    │
    ├── GT 参考时钟输入 (QPLL/CPLL)
    │       │
    │       ├── GT TXOUTCLK → 用户逻辑 TXUSRCLK
    │       └── GT RXOUTCLK → 用户逻辑 RXUSRCLK
    │
    └── 用户逻辑时钟 domain
            │
            ├── TX domain (与 GT TXOUTCLK 同步)
            └── RX domain (与 GT RXOUTCLK 同步)
```

**关键**: TX 和 RX 使用的时钟可能不同频/同源，用户逻辑需要在两侧分别处理 CDC。

---

## 三、接口类型

### 3.1 Streaming 接口 (流模式)

最简单的用法: 原始数据流，无帧边界

```verilog
// Aurora 8B/10B Streaming 接口
module aurora_stream_top (
    input  wire        s_axi_tx_tvalid,
    output wire        s_axi_tx_tready,
    input  wire [0:31] s_axi_tx_tdata,    // 注意 bit 序: [0:31]!
    output wire        m_axi_rx_tvalid,
    output wire [0:31] m_axi_rx_tdata,
    ...
);
```

**注意**: Xilinx Aurora IP 的 AXI 接口使用 **Vivado 非标准 bit 序** `[0:31]` (MSB 是索引 0)！用户逻辑必须注意转换:
```verilog
// 调整 bit 顺序
wire [31:0] data_std = {aurora_tdata[16:31], aurora_tdata[0:15]};  // 数据需要 swap
// 或者使用 axi_stream_dword_swap 模块
```

### 3.2 Framing 接口 (帧模式)

带帧边界，适合按帧传输的场景:

```verilog
// Aurora 8B/10B Framing — 额外信号
s_axi_tx_tvalid, s_axi_tx_tready, s_axi_tx_tdata,
s_axi_tx_tkeep,                     // 字节使能
s_axi_tx_tlast,                     // 帧结束标志

m_axi_rx_tvalid, m_axi_rx_tdata,
m_axi_rx_tkeep,
m_axi_rx_tlast                      // 帧结束
```

流模式 vs 帧模式选择:
- **流模式**: 源源不断的数据流 (ADC 采样、视频流)
- **帧模式**: 包/帧边界的传输 (网络包、指令)

---

## 四、Aurora 配置用例

### 4.1 用例: 多通道数据采集回传

**场景**: RF 前端通过 4 片 ADC (JESD204B) → FPGA → Aurora → CPU

```
ADC0 ──▶ JESD204B RX ──┐
ADC1 ──▶ JESD204B RX ──┤    ┌──────────┐    ┌──────────┐
ADC2 ──▶ JESD204B RX ──┼───▶│ 数据聚合  │───▶│ Aurora   │───▶ CPU
ADC3 ──▶ JESD204B RX ──┘    │  + 打包   │    │ 8B/10B   │    (PCIe)
                             └──────────┘    └──────────┘
```

**配置步骤**:

Step 1: Vivado IP 配置

| 参数 | 本例设置 | 说明 |
|:-----|:---------|:-----|
| Line Rate | 10 Gbps | 8B/10B @ 10G, 实际数据 8Gbps |
| GT Refclk | 250 MHz | 10G / 40 (8B/10B internal) |
| Lane Width | 4 | 4 lane = 40 Gbps 链路 |
| Dataflow Mode | Duplex | 双向 |
| Interface | Framing | 加帧边界，便于接收端定界 |
| Flow Control | UFIFO | 接收端反压保护 |
| GT Drp Clk | 50 MHz | DRP 接口时钟 |

Step 2: 时钟生成

```tcl
# 时钟结构
# 外部 250 MHz → QPLL (10 Gbps)
#            → BUFG → user_clk (125 MHz, 32-bit path)
#            → GT RXOUTCLK → BUFG → rx_clk (125 MHz)

create_clock -period 4.0 [get_ports refclk_250m_p]   # 250 MHz refclk

# Aurora 用户时钟 (lane_width × line_rate / 40 = 125 MHz × 32-bit)
create_generated_clock -name user_clk \
    -source [get_pins aurora_inst/inst/gt_usrclk_src] \
    -divide_by 2 \
    [get_pins aurora_inst/user_clk]
```

Step 3: 数据打包格式

```
┌─────────────────────────────────────────────────────────────┐
│ Aurora Frame                                                 │
│ ┌──────┬──────┬──────────┬──────────┬──────────┬──────────┐ │
│ │ SOP  │ HDR  │ ADC0 数据│ ADC1 数据│ ADC2 数据│ ADC3 数据│ │
│ │ (1B) │ (3B) │ (N bytes)│ (N bytes)│ (N bytes)│ (N bytes)│ │
│ └──────┴──────┴──────────┴──────────┴──────────┴──────────┘ │
│ ┌──────────┬──────┐                                          │
│ │ ADC 数据 │ EOP  │                                          │
│ │ (续)     │ (1B) │                                          │
│ └──────────┴──────┘                                          │
└─────────────────────────────────────────────────────────────┘

Header 说明:
  Byte 0: 帧序号 (递增, 用于丢帧检测)
  Byte 1: 时间戳高 8-bit
  Byte 2: 时间戳中 8-bit
  (时间戳低 8-bit 使用后续帧)
```

Step 4: Aurora 发送逻辑

```verilog
// Aurora 数据定帧发送 (Framing 模式)
module aurora_frame_tx #(
    parameter ADC_SAMPLES_PER_FRAME = 1024
) (
    input  wire        user_clk,
    input  wire        rst_n,
    input  wire        channel_up,         // Aurora 通道建链
    
    // ADC 数据输入 (4 通道)
    input  wire [63:0] adc_data [0:3],
    input  wire        adc_valid,
    
    // Aurora TX 接口
    output reg         s_axi_tx_tvalid,
    input  wire        s_axi_tx_tready,
    output reg [0:31]  s_axi_tx_tdata,
    output reg         s_axi_tx_tlast      // 帧结束 (仅 Framing)
);

    typedef enum {IDLE, WAIT_CHANNEL, SEND_HDR, SEND_DATA, SEND_EOP} state_t;
    state_t state;
    reg [15:0] frame_count;
    reg [15:0] sample_idx;
    reg [2:0]  ch_idx;
    
    always_ff @(posedge user_clk) begin
        if (!rst_n) begin
            state <= IDLE;
            frame_count <= 0;
            s_axi_tx_tvalid <= 0;
        end else begin
            case (state)
                IDLE: if (adc_valid) begin
                    state <= WAIT_CHANNEL;
                end
                
                WAIT_CHANNEL: if (channel_up) begin
                    state <= SEND_HDR;
                    frame_count <= frame_count + 1;
                end
                
                SEND_HDR: begin
                    // SOP byte + header
                    s_axi_tx_tvalid <= 1;
                    s_axi_tx_tdata <= {8'hFB, frame_count[15:8], frame_count[7:0], 8'h00};
                    if (s_axi_tx_tready) begin
                        state <= SEND_DATA;
                        sample_idx <= 0;
                        ch_idx <= 0;
                    end
                end
                
                SEND_DATA: begin
                    s_axi_tx_tvalid <= 1;
                    s_axi_tx_tdata <= {adc_data[ch_idx][31:0], adc_data[3-ch_idx][31:0]};
                    if (s_axi_tx_tready) begin
                        if (ch_idx < 3) begin
                            ch_idx <= ch_idx + 1;
                        end else begin
                            ch_idx <= 0;
                            if (sample_idx < ADC_SAMPLES_PER_FRAME - 1) begin
                                sample_idx <= sample_idx + 1;
                            end else begin
                                state <= SEND_EOP;
                            end
                        end
                    end
                end
                
                SEND_EOP: begin
                    s_axi_tx_tvalid <= 1;
                    s_axi_tx_tdata <= {8'hFD, 24'h0};  // EOP
                    s_axi_tx_tlast <= 1;
                    if (s_axi_tx_tready) begin
                        state <= IDLE;
                        s_axi_tx_tlast <= 0;
                    end
                end
            endcase
        end
    end
endmodule
```

### 4.2 用例: Aurora 64B/66B 芯片间互联

**场景**: 两片 FPGA 通过 Aurora 64B/66B 高速互联

```
FPGA A                         FPGA B
┌──────────────┐   4× GTY    ┌──────────────┐
│  User Logic  │────────────▶│  User Logic  │
│  (25.8 Gbps) │◀────────────│              │
│              │  100 Gbps   │              │
└──────────────┘   链路       └──────────────┘
```

配置:

| 参数 | 设置 |
|:-----|:------|
| IP | Aurora 64B/66B |
| Line Rate | 25.78125 Gbps |
| GT Refclk | 322.265625 MHz |
| Lanes | 4 |
| GT Type | GTY (UltraScale+) |
| Flow Control | None |

**关键**: 64B/66B 编码效率 64/66 = 97%，远高于 8B/10B 的 80%

### 4.3 用例: 动态线速率切换

支持在不重新配置 FPGA 的情况下改变 Aurora 线速率:

```tcl
# Tcl 控制 GT 速率
# 前提: 使用 DRP 接口控制 GT

# 1. 复位 Aurora
reset_aurora aurora_inst

# 2. 通过 DRP 更改 GT 设置
set_property CONFIG.LINE_RATE 12.5 [get_ips aurora_8b10b]

# 3. 重新初始化
initialize_aurora aurora_inst
wait_for_channel_up aurora_inst
```

**应用**: 
- 低速模式 (6.25 Gbps) — 链路质量差时降速保连接
- 高速模式 (12.5 Gbps) — 正常链路时全速

---

## 五、链路层细节

### 4.1 链路建立

```
TX: ┌─────┬─────┬─────┬─────┬─────┬─────┐
    │ Idle│ Idle│Data0│Data1│ ... │ Idle│
    └─────┴─────┴─────┴─────┴─────┴─────┘
       ▲ 时钟补偿序列 (每 10000 周期)
       └─ 通道绑定序列 (多 Lane)

RX: 初始 → 通道对齐 → 绑定 → 数据 → 监控错误
```

### 4.2 时钟补偿

**为什么需要**: Aurora TX/RX 时钟可能有微小频率差 (PPM 量级)，长时间运行时钟偏斜会积累。

- Aurora IP 自动插入/移除时钟补偿序列 (Clock Compensation Sequence)
- 补偿序列在用户数据间插入，对用户透明
- 时钟偏差容忍度: 典型 ±300 ppm

### 4.3 通道绑定 (Channel Bonding)

多 Lane 场景下需要对齐不同 Lane 的数据:
- 发送端定期插入 **通道绑定序列** (Channel Bonding Sequence)
- 接收端检测后调整弹性缓冲对齐
- 绑定序列在 `channel_init()` 完成后开始

### 4.4 流控

三种流控模式:

| 模式 | 原理 | 适用场景 |
|:----|:-----|:--------|
| Native Flow Control | Aurora 层带内流控 | 简单链路 |
| UFIFO (User Flow Control) | 用户自定义流控帧 | 特定协议适配 |
| None | 无流控，全速发送 | 确定性数据流 |

---

## 六、RFSoC 集成场景

### 5.1 天线阵列数据传输

智慧尘埃 AAU 中 Aurora 用于 RFSoC↔RFSoC 或 FPGA↔RFSoC 之间传输 IQ 数据:

```
天线 0 ──► ADC ──► DDC ──► JESD204B RX ──► DU
天线 1 ──► ADC ──► DDC ──► JESD204B RX ──► DU
...                                          │
天线 15──► ADC ──► DDC ──► JESD204B RX ──► DU
                                              │
                                              ├──► Aurora TX ──► 中心处理 FPGA
                                              └──► Aurora TX ──► 中心处理 FPGA
```

优势:
- 比 JESD204B 更灵活 (无固定参数协商)
- 比 PCIe 更轻量 (无 TLP 处理)
- 支持多个 Aurora 链路并行传输

### 5.2 链路预算

| Lane 速率 (Gbps) | 编码 | 有效吞吐/Lane | 4 Lane 总吞吐 | 支持 16 天线(30.72MS/s) |
|:---------------:|:----:|:------------:|:------------:|:----------------------:|
| 6.25 | 8B/10B | 5.0 Gbps | 20 Gbps | ✅ (I/Q 各 16-bit) |
| 10.0 | 8B/10B | 8.0 Gbps | 32 Gbps | ✅ |
| 25.8 | 64B/66B | 25.0 Gbps | 100 Gbps | ✅ (含冗余) |

### 5.3 初始化和监测

```verilog
// Aurora IP 状态监测
wire channel_up;           // 链路状态: 通道建立
wire lane_up[N_LANE];      // 单 Lane 状态
wire hard_err;             // 硬错误 (需要复位)
wire soft_err;             // 软错误 (可恢复)

// 复位序列
always_ff @(posedge clk) begin
    if (init_done) begin
        aurora_reset <= 1'b0;       // 释放复位
        wait(channel_up);            // 等待链路建立
        // 开始发送数据
    end
end
```

---

## 七、调试指南

### 6.1 常见问题

| 问题 | 原因 | 检查 |
|:----|:-----|:-----|
| Lane Up 但 Channel Down | 多 Lane 未绑定 | 检查绑定序列发送/接收 |
| 误码率高 | 信号完整性/时钟质量 | GTY Eye Scan, BER 测试 |
| 偶发 CRC 错误 | 时钟偏斜/电源噪声 | PPM 差异监测, 电源纹波 |
| FPGA 间数据错位 | AXI bit 序问题 | `[0:31]` vs `[31:0]` 确认 |
| IP 核初始化卡死 | GT 参考时钟未锁定 | `gt_pll_lock`, CPLL/QPLL 状态 |

### 6.2 GTY Eye Scan

```tcl
# Vivado Tcl — GTY 眼图扫描
open_hw
connect_hw_server
open_hw_target

set gt [get_hw_cells -filter {NAME =~ "*aurora_gt*/GT*"}]
set_property TX_LOOPBACK 1 $gt

# 水平眼图扫描
program_hw_devices [get_hw_devices]
run_hw_ila [get_hw_ilas -of [get_hw_devices]]

# Tcl scan
set_property EYE_SCAN_ENABLE 1 $gt
set_property EYE_SCAN_TRIG_EN 1 $gt
run_gt_eye_scan $gt

# 垂直余量
report_gt_eye_scan -detail > eye_report.rpt
```

### 6.3 BER 测量

```verilog
// 环回测试: TX → RX (外部线缆环回)
// 在 GT 设置 ENABLE_LOOPBACK=3 (PCS 近端环回)
// 或外部 SMA 线缆环回 (远端)

// 发送 PRBS31 序列
prbs_gen #(.POLY(31)) u_prbs_tx (
    .clk(tx_clk), .rst(rst),
    .en(1'b1), .data_out(tx_data)
);

// 接收侧检测错误
prbs_check #(.POLY(31)) u_prbs_rx (
    .clk(rx_clk), .rst(rst),
    .data_in(rx_data),
    .error_count(err_cnt)
);
```

---

## 八、PCB 设计建议

| 项目 | 要求 |
|:----|:-----|
| 差分阻抗 | 100 Ω ±10% |
| 对内等长 | ≤5 mil |
| 对间等长 | ≤50 mil (多 Lane 绑定用) |
| 参考时钟 | 差分 100 MHz，抖动 <1 ps RMS |
| AC 耦合电容 | 100 nF (靠近 TX 侧) |
| 过孔数量 | 每对 ≤2 个 |

---

## 参考

| 资源 | 说明 |
|:----|:-----|
| [PCIe 指南](./pcie-guide.md) | PCIe 高速接口 |
| [JESD204B 指南](./jesd204b-guide.md) | JESD204B 串行接口 |
| [RFSoC 开发指南](./rfsoc-guide.md) | RFSoC 配置与接口 |
| [Vivado 指南](./vivado-guide.md) | Vivado 使用 |
| PG074 (Aurora 8B/10B) | Xilinx Aurora 8B/10B 产品指南 |
| PG074 (Aurora 64B/66B) | Xilinx Aurora 64B/66B 产品指南 |
