---
name: selectmap-guide
title: "SelectMap 配置指南"
domain: fpga
tags: [selectmap, configuration, bitstream, boot, xilinx]
created: 2026-06-05
updated: 2026-06-05
difficulty: intermediate
---

# SelectMap 配置指南

> Xilinx FPGA SelectMap 并行配置接口 — 协议时序、引脚定义、多 boot 方案、RFSoC 集成。

---

## 一、SelectMap 概述

### 1.1 什么是 SelectMap

SelectMap 是 Xilinx FPGA 的 **8/16/32-bit 并行配置接口**，相比 JTAG 的优势:
- **速度**: 32-bit @ 100 MHz → 400 MB/s，比 JTAG (~3 MB/s) 快 100 倍
- **适用场景**: 批量生产烧录、高速重配置、多 boot 切换

### 1.2 配置方式对比

| 方式 | 宽度 | 典型速度 | 适用场景 |
|:----|:---:|:--------:|:--------|
| **JTAG** | 1-bit | ~3 MB/s | 调试、开发 |
| **SelectMap (Slave)** | 8/16/32-bit | ~50-400 MB/s | 批量生产、动态重配 |
| **SelectMap (Master)** | 8/16/32-bit | ~50-400 MB/s | 从 Flash 加载 |
| **BPI Flash** | 8/16-bit | ~100 MB/s | 存储配置 |
| **SPI Flash** | 1/2/4-bit | ~10-50 MB/s | 小容量低成本 |
| **QSPI** | 4-bit | ~20-50 MB/s | 常用中容量 |
| **SD卡** | 4-bit | ~10-20 MB/s | Zynq 启动 |

---

## 二、引脚定义

### 2.1 引脚列表

| 信号 | 方向 | 宽度 | 功能 |
|:----|:----:|:----:|:-----|
| `D[31:0]` | I/O | 32 | 数据总线 (8/16/32位可选) |
| `CS_B` | I | 1 | 片选 (低有效) |
| `RDWR_B` | I | 1 | 读/写选择 (低=写, 高=读) |
| `BUSY` | O | 1 | 忙标志 (高=忙, 不可写入) |
| `INIT_B` | I/O | 1 | 初始化指示 (低=初始化中) |
| `DONE` | O | 1 | 配置完成 (高=配置成功) |
| `PROGRAM_B` | I | 1 | 重配置触发 (低脉冲) |
| `CCLK` | I/O | 1 | 配置时钟 (Slave=输入, Master=输出) |

### 2.2 Slave SelectMap 时序

```
CCLK     ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐
         │ │ │ │ │ │ │ │ │ │ │ │ │ │
         ─┘ └─┘ └─┘ └─┘ └─┘ └─┘ └─┘ └─

CS_B     ────────────┐   ┌───────────────────
                     └───┘

RDWR_B   ──────────────────── (低=写入)
                           (高=状态回读)

D[31:0]  ──────┐   ┌────┐   ┌────┐   ┌────
               └───┤ D0 ├────┤ D1 ├────┤ ...
                   └────┘    └────┘    └────

BUSY                    ┌──────┐
                   ─────┘      └────────────
```

**时序要求**:
- `tDSCK`: CS_B → CCLK rising 建立时间 ≥ 3 ns
- `tDHD`: 数据保持时间 ≥ 1.5 ns
- `tDBUSY`: BUSY 有效 → 重新写入 ≥ 2 个 CCLK

---

## 三、配置序列

### 3.1 完整配置流程

```
POWER UP
    │
    ├─ 等待电源稳定 (Power-On Reset)
    │
    ├─ INIT_B 拉高 (初始化完成)
    │
    ├─ 同步字: 0xAA995566 (32-bit)
    │
    ├─ 器件 ID 检查 (FPGA 返回器件 ID)
    │   └── 若 ID 不匹配 → 终止配置, INIT_B 拉低
    │
    ├─ 配置帧加载 (Frame by frame)
    │   └── BUSY 高时暂停写入
    │
    ├─ CRC 校验 (内建 CRC 验证配置完整性)
    │
    ├─ DONE 拉高 (配置完成)
    │
    └─ STARTUP 序列 (使能 IO、释放 MMCM 等)
```

### 3.2 同步字序列

任何配置序列必须以 32-bit 同步字开始:

```
写入顺序: 0xAA 0x99 0x55 0x66  (大端序)
        0xFFFFFFFF  (32'hFFFFFFFF  — 对齐哑数据)
        // 或直接写入 0xAA995566
```

同步字让 FPGA 识别位流格式并锁定字节对齐。

### 3.3 配置帧结构

位流文件 (.bit / .bin) 的帧结构:

```
┌─────────────────────────────────┐
│  同步字 (0xAA995566)            │  ← 8 bytes
├─────────────────────────────────┤
│  配置命令区                     │
│  ├─ Type 1 Write WBSTAR        │  ← 写 Warm Boot Start Address
│  ├─ Type 1 Write CMD           │
│  ├─ Type 1 Write FAR           │  ← 写帧地址寄存器
│  ├─ Type 1 Write FDRI × N      │  ← 写入 N 个配置帧 (核心数据)
│  └─ Type 1 Write CMD (Startup) │  ← 启动序列
├─────────────────────────────────┤
│  CRC 校验值                     │  ← 4 bytes
├─────────────────────────────────┤
│  DONE 监测 + STARTUP 等待       │
└─────────────────────────────────┘
```

**Type 1 数据包格式**:
```
Bit [31:29] = 001 (Type 1)
Bit [28:27] = 操作码 (01=写, 10=读)
Bit [26:13] = 寄存器地址
Bit [12:0]  = 字数 (以 32-bit 字为单位)
```

---

## 四、Multi-Boot / Fallback

### 4.1 Multi-Boot 架构

在单个 FPGA 中存储多个位流版本，通过 SelectMap 或内部配置访问 (ICAP) 切换:

```
SPI/BPI Flash 布局:
┌──────────────────────────────────┐
│  Golden Image (安全的稳写版本)      │  ← 固定基址
├──────────────────────────────────┤
│  MultiBoot Image (更新版本)       │  ← WBSTAR 指定地址
├──────────────────────────────────┤
│  用户数据 (NVM, Calibration)     │
└──────────────────────────────────┘

切换机制:
1. 启动 → 加载 Golden (默认)
2. 若 Golden 成功 → DONE=1 → 可选跳转 MultiBoot
3. 若 MultiBoot CRC 失败 → ICAP 回退到 Golden
```

### 4.2 IPROG 命令

FPGA 内部通过 ICAP 发出 IPROG 触发重配置:

```tcl
# 通过 ICAP 或 SelectMap 写 WBSTAR + IPROG
# 1. 写 Warm Boot Start Address (WBSTAR)
write_cfg_reg WBSTAR 0x00200000    # MultiBoot 在 Flash 偏移 2MB

# 2. 发送 IPROG 命令
write_cfg_reg CMD 0x00000004       # CMD = IPROG

# FPGA 将拉低 INIT_B → 重新读取配置
```

### 4.3 Fallback 保护

```tcl
# Golden Image 设置 Fallback
# 在 Golden 位流中:
set_property CONFIG_MODE SPIx4 [current_design]
set_property BITSTREAM.CONFIG.CONFIGFALLBACK ENABLE [current_design]
set_property BITSTREAM.CONFIG.NEXT_CONFIG_ADDR 0x00200000 [current_design]

# 这样 MultiBoot 失败时自动回退到 Golden (地址 0x00000000)
```

---

## 五、RFSoC 配置集成

### 5.1 Zynq UltraScale+ RFSoC 配置

RFSoC (ZU67DR 等) 的配置体系:

```
PS (Processing System)               PL (Programmable Logic)
┌──────────────┐                  ┌────────────────────┐
│  BootROM     │──── CSU ────────▶│  PCAP (配置桥)      │
│  ↓           │                  │  ├─ SelectMap-like  │
│  FSBL        │                  │  └─ ICAP (内部访问) │
│  ↓           │                  │                     │
│  U-Boot/ATF  │                  │  RF-DC (数据转换器)  │
│  ↓           │                  │  ├─ ADC 配置         │
│  Linux       │                  │  ├─ DAC 配置         │
└──────────────┘                  │  └─ Tile 校准        │
                                  └────────────────────┘
```

RFSoC 通过 **PCAP** (Processor Configuration Access Port) 实现类似 SelectMap 的高速配置:
- PS 通过 PCAP 加载 PL 位流 (速度 ≈ 400 MB/s)
- 支持部分动态重配置 (对 RF-DC tile 的独立配置)
- PS 侧的 CSU 负责位流解密和认证 (RSA/AES-GCM)

### 5.2 独立 SelectMap 配置 (非 Zynq RFSoC)

对不需要 PS 的场景，RFSoC 也支持从外部 SelectMap 直接配置 PL:
- Slave SelectMap 32-bit @ 100 MHz
- 必须通过 MIO 或 EMIO 映射 SelectMap 引脚
- 参考 UG1085 (RFSoC TRM) 中配置章节

### 5.3 位流生成

```tcl
# Vivado Tcl — 生成 SelectMap 兼容位流
set_property CONFIG_MODE [config_mode] [current_design]

# 主 SelectMap 32-bit
set_property CONFIG_MODE Master_SelectMap32 [current_design]

# 从 SelectMap 32-bit
set_property CONFIG_MODE Slave_SelectMap32 [current_design]

# 生成位流
set_property BITSTREAM.GENERAL.COMPRESS TRUE [current_design]
write_bitstream -force ./output.bit

# 生成 .bin (SelectMap 用原始二进制)
write_cfgmem -format BIN -force -loadbit "up 0x00000000 ./output.bit" \
    -file ./output.bin -interface SMAPx32

# 生成 .mcs (烧录 SPI Flash)
write_cfgmem -format MCS -size 128 -loadbit "up 0x00000000 ./output.bit" \
    -file ./output.mcs -interface SPIx4
```

---

## 六、硬件设计建议

### 6.1 PCB 布线

| 信号 | 要求 |
|:----|:-----|
| D[31:0] | 等长 ≤25 mil, 包地 |
| CCLK | 50Ω 阻抗匹配, 远离其他信号 ≥3W |
| CS_B/RDWR_B | 加弱上拉 (4.7kΩ) 确保未选中时高态 |
| BUSY | 弱下拉 (1kΩ) 确保 FPGA 未就绪时低态 |
| INIT_B/DONE | 开漏, 加 4.7kΩ 上拉到配置电压 |

### 6.2 配置电压

| FPGA 系列 | VCCO 电压 | 注意 |
|:---------|:---------:|:-----|
| 7-series | 1.8V / 2.5V / 3.3V | 取决于 Bank |
| UltraScale | 1.8V | Bank 65/66 专用 |
| UltraScale+ | 1.8V | Bank 65/66 |

---

## 七、调试

### 7.1 配置失败排查

| 症状 | 原因 | 检查 |
|:----|:-----|:-----|
| INIT_B 不拉高 | 电源/时钟问题 | VCCO、CCLK 是否正常 |
| DONE 不拉高 | CRC 错误/位流不匹配 | 器件 ID 检查、位流版本 |
| BUSY 持续高 | 写入过快 | 检查 tDBUSY 时序 |
| 偶发配置失败 | 信号质量 | 总线上下拉、CCLK 信号质量 |
| MultiBoot 不跳转 | WBSTAR 错误 | 检查 Flash 地址映射 |

### 7.2 Boot Loop 恢复

```tcl
# 如果写入错误位流导致 FPGA 无法启动:
# 1. 拉低 PROGRAM_B (至少 250ns)
# 2. 等待 INIT_B 拉高
# 3. 重新写入 Golden 位流
# 4. DONE 拉高后完成

# 若 PROGRAM_B 无法恢复 (PS 主导):
# 1. 断电重上电
# 2. 或使用 Boundary Scan 强制加载
```

---

## 八、Multi-Boot 方案深度对比

### 8.1 三种 Multi-Boot 架构

| 特性 | Golden + Update | Fallback (自动回退) | Multiboot (WBSTAR 切换) |
|:----|:--------------:|:-------------------:|:----------------------:|
| **Flash 空间** | 2× 位流大小 | 2× 位流大小 | N× 位流大小 |
| **切换方式** | IPROG 命令 | CRC 失败自动回退 | IPROG + WBSTAR |
| **失败恢复** | 手动 IPROG 到 Golden | **自动回退到 Golden** | 需外部 watchdog |
| **版本数量** | 2 | 2 | N (无限制) |
| **安全性** | 需防篡改保护 | 自带防变砖 | 需额外保护 |
| **启动时间** | 取决于跳转逻辑 | 失败→回退需 2× 时间 | 取决于选择逻辑 |
| **复杂度** | 低 | 低 | 中 |
| **适用场景** | 生产烧录 + OTA 更新 | 远程更新 (变砖保护) | A/B 分区 + 多个功能位流 |

### 8.2 推荐架构: Golden + Fallback (远程更新)

```
Flash 布局:
┌───────────────────────────────────────┐
│ 0x000000 ┌───────────────────────┐    │
│          │ Golden Image (只读)   │    │  ← 出厂烧录，不可改写
│          │ - 基本功能            │    │
│          │ - 支持 OTA 下载       │    │
│          └───────────────────────┘    │
├───────────────────────────────────────┤
│ 0x200000 ┌───────────────────────┐    │
│          │ MultiBoot Image       │    │  ← OTA 更新目标
│          │ (当前运行版本)        │    │
│          └───────────────────────┘    │
├───────────────────────────────────────┤
│ 0x400000 ┌───────────────────────┐    │
│          │ 用户数据 / 校准参数    │    │
│          └───────────────────────┘    │
└───────────────────────────────────────┘

启动流程:
  上电 → 加载 Golden (0x000000)
       → DONE=1 → 运行 Golden
       → IPROG → 加载 MultiBoot (0x200000)
       → DONE=1 → 运行 MultiBoot
       
  若 MultiBoot CRC 失败:
       → 自动回退 Golden (0x000000)
       → 运行 Golden (降级模式)
       → 等待 OTA 修复
```

**Golden Image 设计要求**:
- 最小功能集：仅包含通信固件加载器和 OTA 更新逻辑
- 位流大小 ≈ 完整功能位流的 1/5 ~ 1/3
- 出厂后锁定 (写保护)，防止意外覆写

### 8.3 Fallback 配置方法

```tcl
# Golden Image 配置 (Vivado)
set_property BITSTREAM.CONFIG.CONFIGFALLBACK ENABLE [current_design]
set_property BITSTREAM.CONFIG.NEXT_CONFIG_ADDR 0x00200000 [current_design]

# 启用 CRC 检测
set_property BITSTREAM.CONFIG.CRC ENABLE [current_design]

# MultiBoot Image 配置
# 无需特殊属性，但需通过 IPROG 跳转到此
```

```c
// MCU 侧 IPROG 触发代码示例
void switch_to_multiboot(uint32_t flash_addr) {
    // 1. 通过 SelectMap 写 WBSTAR
    selectmap_write(REG_WBSTAR, flash_addr);
    
    // 2. 发送 IPROG 命令
    selectmap_write(REG_CMD, CMD_IPROG);
    
    // 3. 等待 FPGA 重配置
    // FPGA 自动拉低 INIT_B → 重新加载
    while (!gpio_get(PIN_DONE));
    
    printf("Switch to 0x%08X done\n", flash_addr);
}
```

---

## 九、启动时间优化

### 9.1 配置时间模型

配置总时间 = 初始化时间 + 数据加载时间 + 启动序列时间

```
T_total = T_init + (bitstream_size / bus_width / freq) + T_startup

示例 (32-bit SelectMap @ 100 MHz):
  T_init    ≈ 1~3 ms    (POR + INIT_B 拉高)
  T_data    = 40 Mbit / (32 bit × 100 MHz) 
            = 40 Mbit / 3200 Mbps 
            ≈ 12.5 ms
  T_startup ≈ 0.05~0.5 ms (时钟锁相 + IO 使能)
  ─────────────────────────────────────
  T_total   ≈ 14~16 ms
```

### 9.2 不同配置方式对比

| 方式 | 位宽 | 频率 | T_data (40 Mbit) | 相对速度 |
|:----|:---:|:----:|:---------------:|:--------:|
| JTAG | 1-bit | 15 MHz | 2666 ms | 基准 |
| SPI x1 | 1-bit | 50 MHz | 800 ms | 3.3× |
| SPI x4 (QSPI) | 4-bit | 50 MHz | 200 ms | 13× |
| **SelectMap x8** | **8-bit** | **100 MHz** | **50 ms** | **53×** |
| **SelectMap x16** | **16-bit** | **100 MHz** | **25 ms** | **107×** |
| **SelectMap x32** | **32-bit** | **100 MHz** | **12.5 ms** | **213×** |
| BPI x16 | 16-bit | 50 MHz | 50 ms | 53× |
| PCAP (RFSoC) | 32-bit | 200 MHz | **6.25 ms** | **426×** |

### 9.3 优化策略

**策略 1: 位流压缩**

```tcl
# Vivado 位流压缩 (可减少 20~60% 大小)
set_property BITSTREAM.GENERAL.COMPRESS TRUE [current_design]

# 压缩效果取决于设计: 填充多的设计压缩率更高
# ┌──────────────┬──────────┬──────────┬─────────┐
# │ 设计类型      │ 未压缩    │ 压缩后    │ 节省    │
# ├──────────────┼──────────┼──────────┼─────────┤
# │ 小型控制逻辑  │ 8 MB     │ 3 MB     │ 62%     │
# │ 通信算法(DSP) │ 32 MB    │ 18 MB    │ 44%     │
# │ 大型 SoC     │ 80 MB    │ 55 MB    │ 31%     │
# └──────────────┴──────────┴──────────┴─────────┘
```

**策略 2: 提高配置时钟**

```tcl
# 7-series: CCLK max = 100 MHz (Slave SelectMap)
# UltraScale+: CCLK max = 125 MHz (Slave SelectMap)
# 检查器件数据手册确认上限

# RFSoC PCAP 通过 PS 时钟可达 200 MHz
# PS 配置 PL 时使用 PCAP 时钟 = PS_LPD_CLK / 分频系数
```

**策略 3: 部分重配置**

不需要每次重配全部逻辑。只更新改变的模块:

```tcl
# 部分位流生成 (以 RF-DC tile 为例)
# 仅生成特定 tile 的位流，大小 = 完整位流的 1/N
write_bitstream -force -cell [get_cells rf_dc_tile_0] ./partial.bit
```

**策略 4: 多器件并行配置**

```verilog
// 多片 FPGA 菊花链 vs 并行配置
//
// 菊花链 (串联): T_total = T_init + N × T_data + T_startup
//                = 1 + 4 × 12.5 + 0.5 = 51.5 ms (4片)
//
// 并行配置:     T_total = T_init + T_data + T_startup
//                = 1 + 12.5 + 0.5 = 14 ms (同时完成)
//
// 并行要求: 每片 FPGA 独立的 CS_B + BUSY + DONE
//          共享 D[31:0] + CCLK

// SelectMap 并行配置控制器
module parallel_selectmap_ctrl #(
    parameter NUM_DEVICES = 4
) (
    input              clk,
    input              start,
    output reg [31:0]  data_out,
    output reg         cs_b [NUM_DEVICES-1:0],
    input  [NUM_DEVICES-1:0] busy,
    input  [NUM_DEVICES-1:0] done
);

    // 状态机: 同步发送数据到所有 FPGA
    // 独立等待 BUSY 和 DONE
    always_ff @(posedge clk) begin
        for (int i = 0; i < NUM_DEVICES; i++) begin
            if (busy[i]) begin
                cs_b[i] <= 1'b1;  // 暂停该器件
            end else begin
                cs_b[i] <= cs_b[i];  // 继续
            end
        end
    end
endmodule
```

**策略 5: 安全的 Golden Image 精简**

Golden Image 通常 30%~50% 的资源即可运行核心功能:
- 只保留: 时钟管理 (MMCM/PLL) + 通信接口 (SPI/UART) + OTA 逻辑
- 可裁剪: 算法加速器、高速接口、调试逻辑
- 优化后 Golden 可压缩至完整位流的 1/5，加载时间 < 3 ms (SelectMap32)

---

## 十、多器件配置拓扑决策

```
                    ┌───── 场景 ─────┐
                    │                │
              ┌─────┴─────┐   ┌─────┴─────┐
              │  < 4 片    │   │  ≥ 4 片   │
              └─────┬─────┘   └─────┬─────┘
                    │                │
              ┌─────┴─────┐   ┌─────┴─────┐
              │ 启动时间   │   │ 启动时间   │
              │ 敏感?      │   │ 敏感?      │
              │ ┌─┴─┐     │   │ ┌─┴─┐     │
              │ Y   N     │   │ Y   N     │
              │ │   │     │   │ │   │     │
              │ ▼   ▼     │   │ ▼   ▼     │
              │并  菊     │   │混  菊     │
              │联  花     │   │合  花     │
              └───────────┘   └───────────┘

  建议:
  ┌──────────┬──────────┬──────────────────────┐
  │ 片数     │ 启动要求 │ 推荐拓扑              │
  ├──────────┼──────────┼──────────────────────┤
  │ 1~2      │ 任意     │ 菊花链 (最简布线)    │
  │ 2~4      │ < 50 ms  │ 并行 (独立 CS_B)     │
  │ 4~8      │ < 100 ms │ 菊花链 (布线简单)    │
  │ 4~8      │ < 30 ms  │ 混合 (2+2 分组并行)  │
  │ > 8      │ 任意     │ 菊花链 (引脚限制)    │
  └──────────┴──────────┴──────────────────────┘
```

---

## 参考

| 资源 | 说明 |
|:----|:-----|
| [RFSoC 开发指南](./rfsoc-guide.md) | RFSoC 配置与接口 |
| [Vivado 自动化构建](./vivado-automation-guide.md) | Tcl 脚本自动化 |
| [Vivado 使用指南](./vivado-guide.md) | Vivado 基本操作 |
| UG470 (Configuration User Guide) | Xilinx 7-series 配置手册 |
| UG570 (UltraScale Configuration) | UltraScale 配置手册 |
| UG1085 (RFSoC TRM) | RFSoC 技术参考手册 |
