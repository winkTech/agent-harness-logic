---
name: oran-interface
title: "ORAN 同步与接口协议"
tags: [comm, 5g-nr, oran, ecpri, c-plane, u-plane]
description: "│   DU     │  RLC/MAC/High-PHY (实时)"
related: [5g-nr/bfp-compression.md, 5g-nr/dfe-architecture.md, 5g-nr/fr2-beam-management.md, 5g-nr/lowphy-architecture.md, 5g-nr/mimo-detection.md, 5g-nr/nr-frame-structure.md]
---
# ORAN 同步与接口协议

> 最后更新: 2026-06-03
> 关联: [[lowphy-architecture]], [[dfe-architecture]], [[bfp-compression]], [[../lte/overview]]

---

## 1. ORAN 架构概述

### 1.1 功能拆分 (8.0 Option)

```
        ┌──────────┐
        │   CU     │  RRC/PDCP (非实时)
        └────┬─────┘
             │ F1 接口
        ┌────┴─────┐
        │   DU     │  RLC/MAC/High-PHY (实时)
        └────┬─────┘
             │ ORAN CUS 接口 (前传)
        ┌────┴─────┐
        │   RU     │  Low-PHY/RF (极实时)
        └──────────┘
```

### 1.2 O-RU 内部功能

```
ORAN CUS ─→ 解映射 ─→ BFP解压 ─→ 相位补偿 ─→ IFFT ─→ CP ─→ DFE ─→ DAC
                                                     (CFR/DPD)    ↑
                                                                  PA
```

O-RU 对外接口：
| 接口 | 方向 | 内容 |
|:----|:----|:----|
| **C-plane** | DU→RU | 调度与波束赋形控制 (eCPRI msg type 0/5) |
| **U-plane** | DU↔RU | IQ 采样数据 (eCPRI msg type 1) |
| **S-plane** | DU↔RU | 同步与定时 (IEEE 1588 / SyncE) |
| **M-plane** | DU↔RU | 管理与 OAM (NETCONF/YANG) |

---

## 2. C-plane 控制面

### 2.1 消息格式

```
eCPRI 头 (8 bytes) + ORAN 扩展头 (8 bytes) + payload
```

**ORAN 扩展头字段**:

| 字段 | bits | 描述 |
|:----|:----:|:----|
| dataDirection | 1 | 0=UL, 1=DL |
| payloadVersion | 3 | 版本 (通常设为1) |
| filterIndex | 4 | 波束赋形权值索引 |
| frameId | 8 | 无线帧号 (0~255) |
| subframeId | 4 | 子帧号 (0~9) |
| slotId | 4 | 时隙号 |
| symbolId | 6 | OFDM 符号号 (0~13) |
| numberOfSections | 3 | 本消息内 section 数量 |

### 2.2 Section 描述

每个 section 包含：

| 字段 | bits | 描述 |
|:----|:----:|:----|
| sectionId | 12 | section ID (用于 U-plane 关联) |
| rb | 1 | 重发指示 |
| symInc | 1 | 符号递增指示 |
| startPrbu | 10 | PRB 起始索引 (0~4095) |
| numPrbu | 8 | 连续 PRB 数量 |
| reMask | 12 | RE 掩码 (每个 bit 对应一个子载波组) |
| numSymbol | 4 | 本 section 持续符号数 |
| **beamId** | 12 | 波束索引 |

### 2.3 关键时序

```
DL: C-plane 每 OFDM 符号前发出 → 定义本符号的频域资源 + 波束
     O-RU 需在 IFFT 前完成所有配置

UL: C-plane 在对应符号前发出 → 定义上行频域选择
     O-RU 需在 FFT 后、BFP压缩前应用

C-plane 最晚到达时间 (延迟约束):
  DL: 符号开始前 ≲ 5μs (取决于实现)
  UL: 符号开始后 ≲ FFT 完成时间
```

---

## 3. U-plane 用户面

### 3.1 数据格式

```
eCPRI 头 + ORAN U-plane 头 + IQ 数据
```

**U-plane 扩展头字段**:

| 字段 | bits | 描述 |
|:----|:----:|:----|
| sectionId | 12 | 与 C-plane section 关联 |
| prbStart | 10 | 起始 PRB |
| prbCount | 8 | PRB 数量 |
| udCompHdr | 8 | 压缩头 (方法/位宽) |
| reserved | 4 | 预留 |
| iqData | 可变 | IQ 采样 |

### 3.2 IQ 采样格式

**时域格式** (I/Q 交替):

```
[sample0_I, sample0_Q], [sample1_I, sample1_Q], ...
每采样点数: 取决于 O-RU 分段方式和射频带宽
```

**频域格式 (BFP 压缩后)**:

```
[block_exponent][I0/I1/...][Q0/Q1/...]
压缩参数见 [[bfp-compression]]
```

### 3.3 U-plane 时序

```
DU → eCPRI → O-RU:
  每个 OFDM 符号传输 1 个 U-plane 包 (DL)
  或每个 OFDM 符号收到 1 个 U-plane 包 (UL)

Lag: 
  DL: C-plane → U-plane 间隔 < 1 符号 (预知调度)
  UL: O-RU FFT → U-plane 发送 → DU 接收 < 特定延迟
```

---

## 4. S-plane 同步面

### 4.1 IEEE 1588 (PTP) + SyncE

```
┌─────┐  1588 PTP   ┌─────┐
│ DU  │←───────────→│ O-RU│  Slave
│ GM  │             │     │
└─────┘             └─────┘
   │
 SyncE (物理层频率同步)
```

| 同步类型 | 协议 | 精度要求 |
|:---------|:----|:--------:|
| 频率同步 (Freq) | SyncE (G.8262) | ±0.01 ppm |
| 相位同步 (Phase) | IEEE 1588-2008 (PTP) | ±1.5μs (TDD) |
| 时间同步 (Time) | IEEE 1588 + GPS | ±1.5μs (TDD) / ±5μs (FDD) |

### 4.2 TDD 特殊要求

- O-RU 需在 **符号对齐** 的基础上支持灵活的 **TDD 时隙模式**
- C-plane 的符号级调度 + S-plane 的精确时间同步 → 控制上下行切换
- TDD 保护周期 (GP) 取决于同步精度和小区覆盖半径

---

## 5. M-plane 管理面

| 协议 | 传输 | 用途 |
|:----|:----|:----|
| NETCONF | SSH/TLS | O-RU 配置管理 |
| YANG | — | 数据建模 (ORAN 定义标准 YANG 模型) |
| HTTP/2 | TCP | 文件传输 (固件升级) |

**M-plane 典型操作**:
1. O-RU 上电 → DHCP 获取 IP → NETCONF 连接
2. DU 下发配置: 频点/带宽/TDD 模式/波束权值/压缩参数
3. O-RU 上报: 温度/功耗/告警/VSWR
4. 固件升级: DU→O-RU 传输镜像

---

## 6. 前传带宽估算

| 参数 | 值 |
|:----|:----|
| 100MHz NR, 64QAM, 4层, μ=1 (30kHz) | |
| 每符号采样数 | 4096 (FFT) |
| 每符号 IQ 比特 (不压缩) | 2 × 16bit × 4096 = 131kb |
| 每 OFDM 符号 (14 符号) | 1.83 Mb |
| 每时隙 (时域压缩) | 约 2× 提升 |
| BFP 压缩 6bit | 压缩比 ~50% (vs 16bit) |
| 总带宽需求 (fronthaul) | ~25 Gbps (100MHz NR, 4T4R, 无压缩) |
| 压缩后 | ~12.5 Gbps |

**实际部署**: 25GE 前传网络可承载 1×100MHz NR (4层, BFP 6bit)

---

## 7. FPGA 实现要点

### 7.1 ORAN 包解析

```
以太网 MAC → eCPRI 头解析 → ORAN 扩展头解析
  → 按 dataDirection/sectionId 分发到对应处理模块
  → IQ 数据 → BFP 解压/压缩 → 送入 Lowphy 或传出
```

### 7.2 C-plane 缓存策略

- C-plane 包到达时，将 section 信息 **缓存** 到符号配置 RAM
- IFFT 处理时查询符号配置 → 资源映射 + 波束权值选择
- 需要至少 **双缓冲** (当前符号 + 下一符号) 以应付背靠背调度

### 7.3 时延合规

```
以太网 PCS → MAC → ORAN 解析 → BF coeff 加载
  → IFFT → CP 插入 → DFE → DAC
  总时延 < 250μs (ORAN 类别 C 要求)
```

关键路径优化：
- 流水线 PCS 接口：零拷贝 DMA 到 Lowphy 引擎
- C-plane 转波束权值：关联 ROM `[beamId][port][prb] = weight`
- 帧号对齐：使用 S-plane 恢复的时间戳对齐所有处理模块
