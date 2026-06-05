---
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

## 参考

| 资源 | 说明 |
|:----|:-----|
| [RFSoC 开发指南](./rfsoc-guide.md) | RFSoC 配置与接口 |
| [Vivado 自动化构建](./vivado-automation-guide.md) | Tcl 脚本自动化 |
| [Vivado 使用指南](./vivado-guide.md) | Vivado 基本操作 |
| UG470 (Configuration User Guide) | Xilinx 7-series 配置手册 |
| UG570 (UltraScale Configuration) | UltraScale 配置手册 |
| UG1085 (RFSoC TRM) | RFSoC 技术参考手册 |
