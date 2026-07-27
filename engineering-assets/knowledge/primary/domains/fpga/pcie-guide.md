---
name: pcie-guide
title: "PCIe 高速接口设计指南"
domain: fpga
tags: [pcie, high-speed-io, dma, axi, fpga]
created: 2026-06-05
updated: 2026-06-05
difficulty: advanced
---

# PCIe 高速接口设计指南

> 基于 FPGA 的 PCIe 接口设计 — 协议基础、TLP 结构、DMA 架构、Xilinx 实现。

---

## 一、PCIe 协议概览

### 1.1 代际演进

| 代际 | 编码 | 每 Lane 速率 | x8 带宽 | 推出年份 |
|:---|:---:|:----------:|:-------:|:--------:|
| Gen1 | 8B/10B | 2.5 GT/s | ~2 GB/s | 2003 |
| Gen2 | 8B/10B | 5.0 GT/s | ~4 GB/s | 2007 |
| Gen3 | 128B/130B | 8.0 GT/s | ~8 GB/s | 2010 |
| Gen4 | 128B/130B | 16.0 GT/s | ~16 GB/s | 2017 |
| Gen5 | 128B/130B | 32.0 GT/s | ~32 GB/s | 2019 |

**FPGA 常见配置**: Xilinx UltraScale+ 支持 Gen3×8 (≈8 GB/s)，RFSoC 通常 Gen2×4。

### 1.2 拓扑结构

```
CPU/Root Complex
    │
    ├── PCIe Switch (可选)
    │       │
    │       ├── Endpoint 1 (FPGA)
    │       ├── Endpoint 2 (NVMe)
    │       └── Endpoint 3 (GPU)
    │
    └── PCIe Bridge → Legacy PCI (可选)
```

FPGA 通常作为 **Endpoint (EP)**，通过 PCIe 连接到 Root Complex（CPU）或 Switch。

---

## 二、TLP 事务层协议

### 2.1 TLP 格式

PCIe 通信基本单元是 **Transaction Layer Packet (TLP)**:

```
┌─────────┬──────┬────────┬──────────────┬──────────┐
│ STP(1B) │ Seq# │ Header │ Data Payload │ CRC(4B)  │
│         │ (2B) │(12/16B)│  (0~4096B)   │          │
└─────────┴──────┴────────┴──────────────┴──────────┘
```

### 2.2 TLP 类型

| 类型 | 用途 | 方向 |
|:----|:-----|:----:|
| **MRd** (Memory Read) | 读取系统/设备内存 | RC↔EP |
| **MWr** (Memory Write) | 写入系统/设备内存 | RC↔EP |
| **Cpl** / **CplD** (Completion) | 对 MRd 的响应 (不带/带数据) | RC↔EP |
| **Msg** (Message) | 中断 (MSI/MSI-X)、错误报告等 | RC↔EP |
| **IoRd/IoWr/CfgRd/CfgWr** | IO/配置空间访问 | RC→EP |

### 2.3 TLP Header 格式 (32-bit)

以最常见 Memory 请求为例 (3DW header):

```
Byte 0:    Fmt  |  Type  | R | TC | R | Attr | R | TH | TD | EP | Attr | AT |
Byte 1:       Length (DW count, 10-bit)                                    | R |
Byte 2-3:                    Requester ID (Bus/Device/Function)                |
Byte 4-7:                    Tag                              |    Last DW BE   |
Byte 8-11:                   Address [31:2, 1:0=0b00]                         |
```

**关键字段**:
- **Fmt/Type**: 区分 MRd (00 00000)、MWr (10 00000)、CplD (10 01010)
- **Length**: 数据负载长度，单位 4-byte (DW)
- **Requester ID**: 发起者的 BDF (Bus:Device:Function)
- **Tag**: 用于匹配请求与完成
- **Address**: 目标地址 (32-bit 或 64-bit)

### 2.4 Completion 超时

FPGA 端对 MRd 必须在 **50ms** 内响应 Cpl/CplD，否则 CPU 侧报超时错误。

---

## 三、DMA 架构

### 3.1 为什么需要 DMA

PCIe TLP 是 4-byte 对齐的事务，单次 MWr/MRd 上限 4KB。未经 DMA 的 CPU 搬运:
- 每次访问需要驱动层 + 中断开销
- 大块数据传输效率极低

### 3.2 标准 DMA 架构 (Descriptor Ring)

```
CPU 侧:                    FPGA 侧:
┌─────────────┐           ┌────────────────────┐
│  Driver     │           │  PCIe Hard IP      │
│  ───── desc │◄──────────►  ┌──────────────┐  │
│  ring       │  MWr/MRd │  │ DMA IF       │  │
│   ├─ desc1  │           │  │  + TLP engine│  │
│   ├─ desc2  │           │  └──────┬───────┘  │
│   └─ ...    │           │         │segmented  │
│             │           │         │interface  │
│  Buffer     │           │  ┌──────┴───────┐  │
│   ├─ buf1   │◄──────────►  │ DMA Client  │  │
│   ├─ buf2   │  data     │  │ (AXI-Stream) │  │
│   └─ ...    │           │  └──────────────┘  │
└─────────────┘           └────────────────────┘
```

**DMA 传输流程 (H2C: Host-to-Card)**:
1. CPU 在内存中准备数据，写描述符到 ring
2. CPU 写 Doorbell 寄存器，通知 FPGA
3. FPGA DMA IF 读取描述符 (MRd)
4. 解析描述符 → 发起 MWr 从 CPU 内存读取数据
5. 数据通过 segmented memory → DMA client → 用户逻辑

**C2H (Card-to-Host)**:
1. FPGA 用户逻辑数据 → DMA client → segmented memory
2. DMA IF 发起 MWr 写回 CPU 内存
3. DMA IF 写 completion 状态，发 MSI 中断通知 CPU

### 3.3 Segmented Memory Interface

高分段内存接口是比 AXI 更适合 PCIe 的方案:

| 特性 | 分段接口 | AXI |
|:----|:--------|:----|
| 数据对齐 | 单周期对齐 | 需地址译码 |
| 突发 | 无突发，直接 IO | 复杂突发逻辑 |
| 跨时钟域 | 双口 RAM 直连 | 需 AXI FIFO |
| 多客户端 | MUX 自动路由 | 需 AXI Interconnect |
| 性能 | ~高 | 中等 |

### 3.4 参考实现 (verilog-pcie-master)

[verilog-pcie（alexforencich）](https://github.com/alexforencich/verilog-pcie) 提供了完整 DMA 子系统:

### 3.5 DMA 引擎 RTL 核心

```verilog
// ============================================================================
// dma_engine.v — PCIe DMA 引擎核心 (简化版)
// 功能: 描述符环 → TLP 请求 → 数据搬运
// 架构: 3 级流水线 (Fetch Desc → Xfer Data → Post Complete)
// ============================================================================
module dma_engine #(
    parameter DESC_RING_ADDR = 32'h1000_0000,  // 描述符环基址
    parameter MAX_DESC       = 64,              // 描述符数量
    parameter TLP_MAX_PAYLOAD = 1024            // TLP 最大 payload (bytes)
) (
    input  wire       clk,
    input  wire       rst_n,

    // 控制寄存器接口
    input  wire       doorbell_valid,
    output reg        doorbell_ready,
    input  wire [5:0] doorbell_desc_idx,    // 当前完成的 descriptor

    // TLP Master 接口 (到 PCIe Hard IP)
    output reg        m_tlp_valid,
    input  wire       m_tlp_ready,
    output reg [127:0] m_tlp_data,          // TLP header + payload
    output reg [1:0]  m_tlp_type,           // 00=MWr, 01=MRd, 10=CplD
    output reg [9:0]  m_tlp_length,         // DW 长度

    // TLP Slave 接口 (PCIe Hard IP 返回)
    input  wire       s_tlp_valid,
    output reg        s_tlp_ready,
    input  wire [127:0] s_tlp_data,

    // 用户数据接口 (AXI-Stream)
    input  wire       s_axis_valid,
    output reg        s_axis_ready,
    input  wire [63:0] s_axis_data,

    output reg        m_axis_valid,
    input  wire       m_axis_ready,
    output reg [63:0] m_axis_data,

    // 中断
    output reg        irq_msi              // MSI 中断请求
);

    // --- 描述符格式 ---
    // desc[0]: 控制字 {valid, dir, len, last}
    // desc[1]: 源地址 (H2C: CPU 缓冲地址 / C2H: 忽略)
    // desc[2]: 目标地址 (H2C: 忽略 / C2H: CPU 缓冲地址)
    // desc[3]: 用户标记
    // 描述符环: 位于 CPU 内存 (DESC_RING_ADDR)

    typedef struct packed {
        logic        valid;
        logic        dir;       // 0=H2C (FPGA 读 CPU), 1=C2H (FPGA 写 CPU)
        logic [21:0] length;    // 传输字节数
        logic        last;      // 链尾
        logic [7:0]  flags;     // 用户标记
    } desc_ctrl_t;

    // 状态机
    typedef enum {IDLE, FETCH_DESC, WAIT_TLP_RD, XFER_H2C, XFER_C2H, POST_STATUS, SEND_MSI} state_t;
    state_t state, next_state;

    reg [5:0]   desc_idx;               // 当前处理描述符索引
    reg [31:0]  desc_ring[0:3];         // 当前描述符缓存
    desc_ctrl_t desc_ctrl;
    reg [31:0]  xfer_count;             // 已传输字节数
    reg [31:0]  tlp_seq_num;            // TLP 序号 (tag)

    // --- 描述符解析 ---
    assign desc_ctrl.valid  = desc_ring[0][31];
    assign desc_ctrl.dir    = desc_ring[0][30];
    assign desc_ctrl.length = desc_ring[0][29:8];
    assign desc_ctrl.last   = desc_ring[0][7];
    assign desc_ctrl.flags  = desc_ring[0][15:8];

    // --- H2C 传输状态机 ---
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            state <= IDLE;
            desc_idx <= 0;
            xfer_count <= 0;
            irq_msi <= 0;
        end else begin
            state <= next_state;

            case (state)
                IDLE: begin
                    irq_msi <= 0;
                    if (doorbell_valid) begin
                        desc_idx <= doorbell_desc_idx;
                    end
                end

                FETCH_DESC: begin
                    // 发起 MRd 读取描述符环
                    // TLP: MRd, addr = DESC_RING_ADDR + desc_idx * 16
                    if (m_tlp_ready) begin
                        tlp_seq_num <= tlp_seq_num + 1;
                    end
                end

                WAIT_TLP_RD: begin
                    // 等待 CplD 返回描述符数据
                    if (s_tlp_valid) begin
                        desc_ring[0] <= s_tlp_data[31:0];
                        desc_ring[1] <= s_tlp_data[63:32];
                        desc_ring[2] <= s_tlp_data[95:64];
                        desc_ring[3] <= s_tlp_data[127:96];
                    end
                end

                XFER_H2C: begin
                    // H2C: 对 CPU 内存发起 MWr (FPGA 读 CPU 数据)
                    if (xfer_count < desc_ctrl.length) begin
                        if (m_tlp_ready) begin
                            // 组装 TLP: MWr, addr = src + xfer_count
                            // payload 来自 s_axis (用户逻辑数据)
                            xfer_count <= xfer_count + TLP_MAX_PAYLOAD;
                        end
                    end
                end

                XFER_C2H: begin
                    // C2H: 对 CPU 内存发起 MWr (FPGA 写数据到 CPU)
                    // TLP: MWr, addr = dst + xfer_count
                    // 数据来自 s_axis (用户逻辑)
                    if (m_tlp_ready) begin
                        xfer_count <= xfer_count + TLP_MAX_PAYLOAD;
                    end
                end

                POST_STATUS: begin
                    // 写 completion 状态回描述符
                end

                SEND_MSI: begin
                    irq_msi <= 1;
                end
            endcase
        end
    end

    // --- 下一状态逻辑 ---
    always_comb begin
        next_state = state;
        case (state)
            IDLE:           if (doorbell_valid && doorbell_ready) next_state = FETCH_DESC;
            FETCH_DESC:     if (m_tlp_ready)                     next_state = WAIT_TLP_RD;
            WAIT_TLP_RD:    if (s_tlp_valid) begin
                                if (desc_ctrl.valid)
                                    next_state = desc_ctrl.dir ? XFER_C2H : XFER_H2C;
                                else
                                    next_state = IDLE;
                            end
            XFER_H2C:       if (xfer_count >= desc_ctrl.length)  next_state = POST_STATUS;
            XFER_C2H:       if (xfer_count >= desc_ctrl.length)  next_state = POST_STATUS;
            POST_STATUS:    if (m_tlp_ready)                     next_state = SEND_MSI;
            SEND_MSI:                                               next_state = IDLE;
        endcase
    end

    // --- 输出 (简化) ---
    // doorbell_ready: 只在 IDLE 接收 doorbell
    // m_tlp/tlp_type/tlp_length: 根据状态组装 TLP 请求
    // s_axis_ready/m_axis_valid: 数据通路控制

endmodule
```

### 3.6 DMA 性能估算

```
PCIe Gen3 x8:
  理论带宽: 8 Gbps × 8 lanes = 64 Gbps = 8 GB/s
  开销:
    - TLP 头: 12-20 bytes / 最大 payload 4096 bytes → ~0.5%
    - 描述符读取: ~200 ns / 1MB 传输 → 可忽略
    - MSI 中断: ~1 μs / 每次 DMA → 适合 ≥ 64KB 块
  实际 DMA 带宽:
    - 连续传输: ~6.5 GB/s (81% 利用率)
    - 小包随机: ~800 MB/s (受中断 + 描述符开销)

PCIe Gen4 x16:
  理论: 32 GB/s
  实际 DMA: ~26 GB/s (取决于描述符效率)
```

**注意**: 实际 DMA 性能取决于:
- TLP Max Payload Size (MPS) — 越大效率越高
- TLP 读取请求大小 (MRRS) — 匹配 MPS
- 描述符环缓存 (Prefetch) — 提前读取下一个描述符
- 中断合并 (Interrupt Coalescing) — 减少 MSI 数量

| 模块 | 功能 |
|:----|:-----|
| `dma_if_pcie` | PCIe TLP ↔ Segmented Memory 桥接 |
| `dma_if_axi` | AXI ↔ Segmented Memory 桥接 |
| `dma_client_axis_sink` | AXI-Stream 写入 DMA (H2C) |
| `dma_client_axis_source` | AXI-Stream 读取 DMA (C2H) |
| `dma_psdpram` | 双口分段内存 RAM |
| `dma_if_mux` | 多客户端 MUX (tag 自动路由) |

---

## 四、Xilinx PCIe 实现

### 4.1 接口适配

Xilinx 7-series / UltraScale / UltraScale+ 使用 `pcie_us_if` 适配层:

```
PCIe Hard IP (DMA/PCIe Subsystem)         FPGA Logic
┌────────────────────────┐              ┌──────────┐
│  AXI4-Stream TLP       │─────────────►│ TLP      │
│  (req/completer)       │              │ Demux    │
│                        │◄─────────────┤          │
│  Configuration Space   │◄────────────►│ BAR      │
│  (CFG)                 │              │ Handler  │
│                        │              │          │
│  MSI Interrupt         │◄─────────────│ MSI Gen  │
└────────────────────────┘              └──────────┘
```

### 4.2 BAR 映射

```verilog
// BAR0: 32-bit, 1MB, for register access (AXI-Lite)
pcie_axil_master_minimal #(
    .BAR_ADDR_WIDTH(20),     // 1MB
    .BAR_PCIE_ADDR(32'hA000_0000)
) u_bar0 (
    .clk(clk), .rst(rst),
    .s_pcie_header(s_axis_tlp),
    .m_axil_aw(m_axil_aw),
    .m_axil_w(m_axil_w),
    .m_axil_b(m_axil_b),
    .m_axil_ar(m_axil_ar),
    .m_axil_r(m_axil_r)
);

// BAR2: 64-bit, 4GB, for DMA data (AXI)
pcie_axi_master #(
    .BAR_ADDR_WIDTH(32),     // 4GB
    .BAR_PCIE_ADDR(64'h1_0000_0000)
) u_bar2 (...);
```

### 4.3 MSI/MSI-X 中断

```verilog
// MSI 中断发送
// 在 Xilinx PCIe IP 中配置 MSI 功能
// FPGA 侧通过写特定寄存器触发

// MSI: 最多 32 个中断向量
wire [4:0] msi_vector;
wire       msi_valid;
pcie_msi #(
    .MSI_COUNT(4)      // 4 个中断向量
) u_msi (
    .clk(clk),
    .s_axis_tx(s_axis_msi_tlp),
    .msi_vector(msi_vector),
    .msi_valid(msi_valid)
);
```

### 4.4 IP 配置建议

| 参数 | 建议值 | 说明 |
|:----|:------|:-----|
| Lane Width | x4 / x8 | 根据带宽需求 |
| Max Payload Size | 512 / 1024 bytes | 较大值提高吞吐 |
| Reference Clock | 100 MHz | 标准差分参考时钟 |
| BAR 个数 | 2 (1xAXIL + 1xAXI) | 控制和数据分离 |
| MSI 使能 | 是 | 替代传统 INTx |

---

## 五、Cocotb 测试

[verilog-pcie（alexforencich）](https://github.com/alexforencich/verilog-pcie) 包含 30+ cocotb 测试，使用:

```python
# pip install cocotbext-pcie cocotbext-axi

import cocotb
from cocotbext.pcie import (
    PcieMemoryTLP,
    PcieCompletionTLP,
    RootPort,
)

async def test_dma_read(dut):
    """测试 DMA 从 FPGA 读数据回 CPU"""
    rp = RootPort()

    # FPGA 发起 DMA 写
    data = b'\x01\x02\x03\x04' * 1024
    tlp = PcieMemoryTLP.create_mwr(
        address=0x1_0000_0000,
        data=data
    )
    await rp.send(tlp)
```

---

## 六、调试指南

### 6.1 常见问题

| 症状 | 原因 | 检查点 |
|:----|:-----|:-------|
| `lspci` 找不到设备 | PCIe link 未建立 | Lane 状态、参考时钟、复位 |
| 驱动 probe 失败 | BAR 映射失败 | `lspci -vv` 检查 BAR 地址范围 |
| DMA 数据错位 | TLP 长度/地址未对齐 | TLP Header Length 字段 |
| 中断未触发 | MSI 配置错误 | MSI enable 寄存器、Vector 映射 |
| Completion 超时 | MRd 未响应 | 50ms 内必须返回 Cpl/CplD |

### 6.2 lspci 诊断

```bash
# 查看 FPGA 设备
lspci -d 10ee:    # Xilinx Vendor ID
lspci -s 03:00.0 -vv  # 详细 Capability

# LnkSta 查看 link 状态
#   Speed 8GT/s = Gen3
#   Width x8
# LnkCap 查看最大能力
# DevSta 查看错误状态
```

### 6.3 ILA 探针要点

| 信号 | 探针位置 | 说明 |
|:----|:--------|:-----|
| `s_axis_tx_tready` | PCIe IP 输出 | FPGA 是否可发送 TLP |
| `m_axis_rx_tvalid` | PCIe IP 输出 | CPU 是否发送 TLP |
| `cfg_aer_*` | PCIe IP | 高级错误报告 |
| DMA descriptor 状态 | DMA IF | 确认描述符被读取 |

---

## 七、对比表: 高速接口选择

| 特性 | PCIe | Aurora | JESD204B |
|:----|:----:|:------:|:--------:|
| 典型应用 | CPU↔FPGA 通信 | FPGA↔FPGA 数据流 | ADC↔FPGA 采样 |
| 最大速率 | Gen5×16 ≈ 64 GB/s | 64B/66B × 25.8 Gbps | 32 Gbps (C2) |
| 协议复杂度 | 高 (TLP/DMA/中断) | 低 (简单链路) | 中 (参数协商) |
| 延迟 | 中等 (μs 级) | 低 (ns 级) | 极低 (确定性) |
| 拓扑 | 树形 (Switch) | 点对点 | 点对多点 |
| FPGA 资源 | 高 (Hard IP + 逻辑) | 中 (Hard IP + 少逻辑) | 中 (GTY + 逻辑) |

---

## 参考

| 资源 | 说明 |
|:----|:-----|
| [Aurora 指南](./aurora-guide.md) | Aurora 高速接口 (本系列) |
| [JESD204B 指南](./jesd204b-guide.md) | JESD204B 串行接口 |
| [Vivado 指南](./vivado-guide.md) | Vivado 使用流程 |
| [Vivado 自动化构建](./vivado-automation-guide.md) | Tcl 脚本自动化 |
| `verilog-pcie-master` | 参考工程 (74+ RTL, 30+ cocotb 测试) |
| UG906 (Timing Closure) | Xilinx 时序收敛手册 |
| UG949 (Methodology) | Xilinx 设计方法论 |
