---
name: overview
title: "5G NR 系统架构概述"
tags: [comm, 5g-nr, overview]
description: "┌────────────┴─┐      ┌─┴────────────┐"
related: [5g-nr/bfp-compression.md, 5g-nr/dfe-architecture.md, 5g-nr/fr2-beam-management.md, 5g-nr/lowphy-architecture.md, 5g-nr/mimo-detection.md, 5g-nr/nr-frame-structure.md]
---
# 5G NR 系统架构概述

> 最后更新: 2026-06-04
> 关联: [[nr-frame-structure]], [[lowphy-architecture]], [[oran-interface]], [[oran-ric]], [[../lte/overview]]

---

## 1. NG-RAN 架构

### 1.1 整体架构

```
                            ┌──────────────────────┐
                            │         5GC          │
                            │  (AMF/UPF/SMF ...)   │
                            └────┬──────────┬──────┘
                                 │ NG-C     │ NG-U
                    ┌────────────┴─┐      ┌─┴────────────┐
                    │     gNB      │      │     gNB       │
                    │  ┌─────────┐ │  Xn  │ ┌─────────┐   │
                    │  │   CU    │←┼──────┼→│   CU    │   │
                    │  └────┬────┘ │      │ └────┬────┘   │
                    │       │ F1   │      │      │ F1     │
                    │  ┌────┴────┐ │      │ ┌────┴────┐   │
                    │  │   DU    │ │      │ │   DU    │   │
                    │  └────┬────┘ │      │ └────┬────┘   │
                    │       │ ORAN │      │      │        │
                    │  ┌────┴────┐ │      │ ┌────┴────┐   │
                    │  │   RU    │ │      │ │   RU    │   │
                    └──┴─────────┴─┘      └─┴─────────┴───┘
                          │   │               │    │
                         UE  UE              UE   UE
```

| 网元 | 功能 | 接口 |
|:----|:----|:----|
| **gNB** | NR 基站整体，可拆分 CU+DU+RU | Xn (gNB间), NG (核心网) |
| **CU** (Central Unit) | RRC/PDCP/SDAP 处理，非实时调度 | F1 (CU-DU), NG (5GC), Xn (gNB间) |
| **DU** (Distributed Unit) | RLC/MAC/High-PHY，实时调度，HARQ | F1 (CU-DU), ORAN CUS (DU-RU) |
| **RU** (Radio Unit) | Low-PHY (FFT/IFFT/波束赋形) + RF | ORAN CUS (DU-RU) |
| **UE** | 用户终端 | Uu (空中接口) |

### 1.2 功能拆分选项 (3GPP TR 38.801)

```
        ┌──────────┐
Option 8│   RU     │  RF 处理 + 功放               (纯射频，全 PHY 在 DU)
        ├──────────┤
Option 7│   DU-RU  │  Low-PHY ↔ High-PHY 分离      (ORAN 前传典型)
        │          │
        │  7.1:    │  频域 IQ 分离 (最宽前传带宽)
        │  7.2a:   │  预编码后 IQ 分离 (ORAN Cat A)
        │  7.2b:   │  预编码前 IQ 分离 (ORAN Cat B)
        │  7.3:    │  仅调制后 IQ 过前传 (RLC 以下在 DU)
        ├──────────┤
        │   DU     │  RLC/MAC/High-PHY              (实时调度)
        ├──────────┤
Option 2│   CU     │  PDCP/RRC/SDAP                 (非实时，基带池化)
        └──────────┘
```

**当前 O-RAN 前传部署主流：Option 7.2x (Cat A / Cat B)**

| 拆分点 | 前传带宽 | 优点 | 缺点 |
|:----|:----|:----|:----|
| **Option 8** | 时域 IQ (极大) | 前传极简、RU 最轻量 | 前传带宽极高 |
| **Option 7.2** | 频域 IQ (中等) | 前传带宽可控、RU 可波束赋形 | 需 BFP 压缩 |
| **Option 2** | 用户包/IP (最小) | 统计复用、CU 池化 | DU 仍需近天线部署 |

### 1.3 O-RAN 前传平面 (DU ↔ RU)

参见 [[oran-interface]] 详细文档。

| 平面 | 协议 | 内容 |
|:----|:----|:----|
| **C-plane** | eCPRI msg type 0/5 | 调度信息、波束赋形权值、时隙配置 |
| **U-plane** | eCPRI msg type 1 | IQ 采样数据 (BFP 压缩后) |
| **S-plane** | IEEE 1588 / SyncE | 时钟同步与定时 |
| **M-plane** | NETCONF/YANG | 配置管理与 OAM |

---

## 2. 核心网连接

### 2.1 5GC 网络功能 (SBA — 服务化架构)

```
┌────────┐  ┌────────┐  ┌────────┐
│  AMF   │  │  SMF   │  │  PCF   │   ... 控制面 NF
└───┬────┘  └───┬────┘  └───┬────┘
    │  HTTP/2 + JSON (SBI — Service-Based Interface)
    ├───────────┼───────────┤
    │           │           │
    ▼           ▼           ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │  UPF │  │  UPF │  │  UPF │  用户面
  └──┬───┘  └──┬───┘  └──┬───┘
     │         │         │
     └─────────┼─────────┘
               │ N3 (NG-U)
          ┌────┴────┐
          │   gNB   │
          └─────────┘
```

| 网络功能 | 全称 | 职责 |
|:----|:----|:----|
| **AMF** | Access and Mobility Management Function | UE 注册、连接管理、移动性管理、NAS 信令路由 |
| **UPF** | User Plane Function | 用户面数据转发、QoS 执行、计费、流量路由 |
| **SMF** | Session Management Function | PDU 会话建立/释放、IP 分配、UPF 选择与控制 |
| **AUSF** | Authentication Server Function | UE 鉴权 |
| **UDM** | Unified Data Management | 用户签约数据管理 |
| **PCF** | Policy Control Function | QoS 策略、计费策略 |
| **NRF** | Network Repository Function | NF 服务发现与注册 |

### 2.2 NG 接口

| 接口 | 协议 | 功能 |
|:----|:----|:----|
| **NG-C** (N2) | NGAP/SCTP | gNB ↔ AMF：NAS 传输、UE 上下文管理、PDU 会话管理 |
| **NG-U** (N3) | GTP-U/UDP/IP | gNB ↔ UPF：用户面数据隧道、QoS 流映射 |

### 2.3 SA vs NSA 组网对比

```
SA (独立组网)                          NSA (非独立组网, Option 3x)

  ┌──────┐      ┌──────┐               ┌──────┐   ┌──────┐
  │ 5GC  │      │  UE  │               │ EPC  │   │  UE  │
  └──┬───┘      └──┬───┘               └──┬───┘   └──┬───┘
     │ NG-C/NG-U   │                     │ S1-C    │
  ┌──┴─────────────┴──┐              ┌───┴──────────┴────┐
  │       gNB         │              │   LTE eNB (MeNB)  │
  └───────────────────┘              └──────┬────────────┘
                                           │ X2-C/X2-U
                                    ┌──────┴────────────┐
                                    │  NR gNB (SgNB)   │
                                    └───────────────────┘
```

| 维度 | SA (独立组网) | NSA (非独立组网) |
|:----|:----|:----|
| **核心网** | 5GC | EPC (主锚点) |
| **控制面锚点** | gNB → AMF | LTE eNB → MME |
| **NR 角色** | 独立小区 | 辅助数据管道 (SCG) |
| **语音方案** | VoNR / EPS fallback | 必须 VoLTE |
| **NR-LTE 互通** | 通过 5GC N26 互操作 | X2 双连接 |
| **网络切片** | 原生支持 | 不支持 |
| **典型应用** | 纯 5G 网络 (中国) | 早期 5G 部署 (欧美/韩) |
| **部署复杂度** | 高 (需新建 5GC) | 低 (利旧 EPC) |

---

## 3. 协议栈 — 用户面

### 3.1 用户面协议栈 (UE ↔ UPF)

```
UE                                              gNB                                             UPF
┌──────────────┐                           ┌──────────────┐                                ┌──────────┐
│   IP / PDU   │                           │              │                                │ IP / PDU │
├──────────────┤                           │              │                                ├──────────┤
│    SDAP      │◄────────  QoS 流映射 ──────┤    SDAP      │◄────── N3 GTP-U ──────────────┤  GTP-U   │
├──────────────┤  无线承载 (RB) 映射        ├──────────────┤                                ├──────────┤
│    PDCP      │◄─── 加密/完整性/ROHC ──────┤    PDCP      │                                │ UDP/IP   │
├──────────────┤                           ├──────────────┤                                └──────────┘
│    RLC       │◄─── 分段/ARQ 重传 ────────┤     RLC      │
├──────────────┤                           ├──────────────┤
│    MAC       │◄─── 调度/HARQ/复用 ───────┤     MAC      │
├──────────────┤                           ├──────────────┤
│    PHY       │◄─── OFDMA/CP-OFDM/DFT-s  ─┤     PHY      │
└──────────────┘                           └──────────────┘
     Uu 接口                                   
```

### 3.2 各层功能

| 层 | NR 特性 | 与 LTE 差异 |
|:----|:----|:----|
| **SDAP** | NR 新增层。5QI → DRB 映射，QoS 流标识 (QFI) 标记 | LTE 无此层，QoS 由 PDCP 直接映射 |
| **PDCP** | 加密 (AES/SNOW/ZUC-256)、完整性保护、ROHC 头压缩、重复传输 (PDCP duplication for URLLC) | NR 支持 256-bit 加密、PDCP 复制、按 packet 丢弃 |
| **RLC** | UM/AM 模式、分段与重组、ARQ 重传 (AM) | NR RLC 不做级联 (级联下移到 MAC) |
| **MAC** | 调度、HARQ (异步自适应)、优先级处理、逻辑信道复用、随机接入 | NR 支持灵活 TDD 调度、mini-slot 调度、免调度 (GF) |
| **PHY** | CP-OFDM (DL+UL), DFT-s-OFDM (UL 覆盖增强), OFDMA | NR 多 numerology (SCS 可变), LTE 固定 15kHz |

---

## 4. 协议栈 — 控制面

### 4.1 控制面协议栈

```
UE                                              gNB                           AMF
┌──────────────┐                           ┌──────────────┐             ┌──────────┐
│     NAS      │◄────── 注册/鉴权/会话 ─────────────────────────────────►│   NAS    │
├──────────────┤                           ├──────────────┤             ├──────────┤
│     RRC      │◄─── 连接/移动性/测量 ──────┤     RRC      │             │  NGAP    │
├──────────────┤                           ├──────────────┤             ├──────────┤
│    PDCP      │◄─── 加密/完整性 ──────────┤    PDCP      │             │  SCTP    │
├──────────────┤                           ├──────────────┤             ├──────────┤
│    RLC/MAC   │                           │   RLC/MAC    │             │   IP     │
├──────────────┤                           ├──────────────┤             └──────────┘
│     PHY      │                           │     PHY      │
└──────────────┘                           └──────────────┘
     Uu                                          NG-C (N2)
```

| 子层 | 端点 | 功能 |
|:----|:----|:----|
| **NAS** (Non-Access Stratum) | UE ↔ AMF | 注册管理 (5G-GUTI)、PDU 会话建立、鉴权与安全、网络切片选择 (NSSAI) |
| **RRC** (Radio Resource Control) | UE ↔ gNB | 连接控制、移动性管理 (切换/重选)、系统信息广播、测量配置与上报 |
| **PDCP** | UE ↔ gNB | RRC 消息的加密与完整性保护 |
| **RLC/MAC/PHY** | UE ↔ gNB | 同用户面 |

### 4.2 RRC 状态 (3GPP TS 38.331)

```
                    ┌─────────────┐
                    │  RRC_IDLE   │  ← 初始接入 / PLMN 选择后
                    └──────┬──────┘
                           │ RRC Setup Request
                           ▼
                    ┌─────────────┐
          ┌─────────│ RRC_CONNECT │──────────┐
          │         └──────┬──────┘          │
          │ RRC Release    │                 │ NAS Detach / RLF
          │ (suspendConfig)│ RRC Release     │
          ▼                ▼                 ▼
   ┌──────────────┐  ┌─────────────┐
   │ RRC_INACTIVE │  │  RRC_IDLE   │
   └──────┬───────┘  └─────────────┘
          │ RRC Resume Request
          ▼
   ┌──────────────┐
   │ RRC_CONNECT  │
   └──────────────┘
```

| 状态 | 核心网连接 | UE 上下文存储 | 寻呼区域 | 移动性 | 功耗 |
|:----|:----|:----|:----|:----|:----:|
| **RRC_IDLE** | 无 (仅 NAS 注册) | 无 (仅核心网有) | 跟踪区 (TA) | 小区重选 | 最低 |
| **RRC_INACTIVE** | 有 (CM-CONNECTED) | gNB + UE 均保留 | RNA (RAN Notification Area) | 小区重选 (RNA内) | 低 |
| **RRC_CONNECTED** | 有 (CM-CONNECTED) | gNB + 核心网 | 小区级 | 切换 (网络控制) | 最高 |

**RRC_INACTIVE — NR 核心创新：**

- UE 上下文在 gNB 和 UE 中同时保存 (包括 AS 安全上下文、承载配置)
- 数据到达时通过 **RRC Resume** 快速恢复 (信令开销远低于 IDLE→CONNECT 完整建立)
- 适合小包间歇性业务 (IoT、推送通知、即时消息)

### 4.3 NAS 信令流程 (注册示例)

```
UE                         gNB                        AMF
 │                          │                          │
 │── RRC Setup Request ────►│                          │
 │◄── RRC Setup ────────────│                          │
 │── RRC Setup Complete ────│                          │
 │  (含 Registration Req)   │── INITIAL UE MSG ───────►│
 │                          │  (含 Registration Req)   │
 │                          │◄── DL NAS TRANSPORT ─────│
 │◄── DL Info Transfer ────│  (鉴权/NAS Security)     │
 │  (鉴权/NAS Security)      │                          │
 │                          │                          │
 │── UL Info Transfer ──────│── UL NAS TRANSPORT ─────►│
 │  (鉴权响应)               │  (鉴权响应)              │
 │                          │◄── INITIAL CONTEXT SETUP─│
 │◄── RRC Reconfiguration ──│  (SecurityMode+SessSetup) │
 │── RRC Reconfig Complete ─│── INITIAL CTX RESP ─────►│
 │                          │                          │
        [UE 已注册, 进入 CM-CONNECTED / RRC_CONNECTED]
```

---

## 5. NR 关键能力

### 5.1 频段

```
FR1 (Sub-7 GHz):  ◀─────────────────────────────────▶
                  410 MHz                    7125 MHz
                  ├─────────── n77/n78/n79 ──────────┤
                  │  (C-band: 3.3-5.0 GHz)           │
                  ├──── n1/n3/n5/n7/n8 (重耕 LTE) ───┤

FR2-1 (mmWave):          ◀──────────────────────────▶
                        24.25 GHz            52.6 GHz
                        ├── n257/n258/n261 ──────────┤

FR2-2 (mmWave Ext, R17):              ◀──────────────▶
                                    52.6 GHz  71 GHz
```

| 频段 | 范围 | 典型频段 | 双工 |
|:----|:----|:----|:----|
| **FR1** | 410 - 7125 MHz | n1 (2100), n3 (1800), n41 (2500), n77 (3.3-4.2G), n78 (3.3-3.8G), n79 (4.4-5.0G) | FDD / TDD |
| **FR2-1** | 24.25 - 52.6 GHz | n257 (26.5-29.5G), n258 (24.25-27.5G), n261 (27.5-28.35G) | TDD |
| **FR2-2** | 52.6 - 71 GHz | Rel-17 新增, 尚未商用 | TDD |

### 5.2 带宽与 Numerology

| 参数 / μ | μ=0 | μ=1 | μ=2 | μ=3 |
|:----|:----:|:----:|:----:|:----:|
| **子载波间隔 (SCS)** | 15 kHz | 30 kHz | 60 kHz | 120 kHz |
| **时隙长度** | 1 ms | 0.5 ms | 0.25 ms | 0.125 ms |
| **符号长度 (不含CP)** | 66.67 μs | 33.33 μs | 16.67 μs | 8.33 μs |
| **每子帧时隙数** | 1 | 2 | 4 | 8 |
| **适用频段** | FR1 | FR1/FR2 | FR1/FR2 | FR2 |
| **数据信道支持** | 是 | 是 | 是 | 是 |
| **SSB 专属 μ=4** | — | — | — | — (240kHz, 仅SSB) |

| 频段 | 最大信道带宽 | 最大 RB 数 | 典型配置 |
|:----|:----:|:----:|:----|
| FR1 (μ=0) | 50 MHz | 270 | LTE 共站 |
| FR1 (μ=1) | 100 MHz | 273 | C-band 主流 (n77/n78) |
| FR1 (μ=2) | 100 MHz | 135 | FR1 大 SCS 部署 |
| FR2 (μ=2) | 200 MHz | 264 | mmWave |
| FR2 (μ=3) | 400 MHz | 264 | mmWave 宽带 |

### 5.3 延迟目标

| 场景 | 目标 | 定义 |
|:----|:----:|:----|
| **eMBB 用户面** | 4 ms | 单向 (UE → UPF) |
| **URLLC 用户面** | 0.5 ms | 单向 (UE → UPF), 32B 小包 |
| **URLLC 控制面** | 10 ms | IDLE → CONNECT (含随机接入) |
| **eMBB 空口单向** | 1 ms | 理想 TDD 配置下 |
| **Mini-slot** | 2/4/7 符号 | 抢占式调度，超低延迟 |

### 5.4 MIMO 能力

| 方向 | Rel-15 | Rel-16/17 | 最大天线端口 | 关键特性 |
|:----|:----:|:----:|:----:|:----|
| **DL 层数** | 8 | 16 | 32 | Type I/II CSI 码本, MU-MIMO 12层 |
| **UL 层数** | 4 | 8 | 8 | 码本/非码本预编码, 全功率 Tx |
| **波束管理** | P1/P2/P3 | 增强 BFR | — | 波束扫描+波束恢复 (BFR), 最多 64 波束 |

### 5.5 调制与编码

| 调制 | 每符号比特 | DL 支持 | UL 支持 | 备注 |
|:----|:----:|:----:|:----:|:----|
| QPSK | 2 | 是 | 是 | 控制/广播信道 |
| 16QAM | 4 | 是 | 是 | — |
| 64QAM | 6 | 是 | 是 | — |
| 256QAM | 8 | 是 | 是 | 高 SINR |
| 1024QAM | 10 | Rel-16 | Rel-17 | 极高 SINR (室内/固定无线) |

| 信道 | 编码 | 码率范围 | 备注 |
|:----|:----|:-----|:----|
| 数据信道 (PDSCH/PUSCH) | LDPC (BG1/BG2) | 1/5 ~ 8/9 | 准循环 LDPC，双基图 |
| 控制信道 (PDCCH/PUCCH) | Polar | — | 分布 CRC，列表译码 |
| 广播信道 (PBCH) | Polar | — | — |

---

## 6. 部署场景

### 6.1 ITU IMT-2020 三大场景

```
          ┌──────────────────────────────────────┐
          │            eMBB                       │
          │  增强移动宽带                       │
          │  · 峰值速率: DL 20 Gbps / UL 10 Gbps │
          │  · 频谱效率: 3x LTE                  │
          │  · 典型: 4K/8K视频, AR/VR, 云游戏     │
          └───────────┬──────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             │             ▼
┌───────────────┐     │      ┌───────────────┐
│    URLLC      │     │      │    mMTC       │
│ 超可靠低延迟 │     │      │ 大规模机器类 │
│ · 延迟 0.5ms │     │      │ · 连接密度    │
│ · 可靠性 99.9999%│  │      │   1M/km²     │
│ · 典型: 工业自动 │  │      │ · 典型: NB-IoT│
│   化, V2X, 远程手│  │      │   /eMTC演进   │
│   术            │     │      │               │
└───────────────┘     │      └───────────────┘
                      │
                      ▼
        ┌───────────────────────────┐
        │     扩展场景 (Rel-16/17/18)│
        │                           │
        │  · NR-U (NR in Unlicensed)│
        │  · NTN (非地面网络, 卫星) │
        │  · V2X (车联网 sidelink) │
        │  · IIoT (工业物联网)     │
        │  · 定位 (<1m 精度)       │
        │  · RedCap (轻量 NR)      │
        │  · 多播广播 (MBS)        │
        └───────────────────────────┘
```

### 6.2 扩展场景详解

| 场景 | 标准 | 核心特性 | 典型用例 |
|:----|:----|:----|:----|
| **NR-U** | Rel-16 | 5GHz/6GHz 非授权频段，LBT 先听后说，与 Wi-Fi 共存 | 企业专网、室内热点 |
| **NTN** | Rel-17 | GEO/GSO/LEO 卫星接入，大时延补偿 (最大 540ms)，多普勒预补偿 | 偏远覆盖、海事、航空 |
| **V2X (NR SL)** | Rel-16/17 | PC5 直连 (sidelink)，广播/组播/单播，20MHz ~ 400MHz | 自动驾驶车队、V2V/V2I/V2P |
| **IIoT** | Rel-16 | TSN 集成、5G-LAN、URLLC 增强 | 工厂自动化、电网、港口 |
| **定位** | Rel-16/17 | DL-TDOA, UL-TDOA, Multi-RTT, AoA/AoD, <1m (R17) | 室内定位、资产追踪 |
| **RedCap** | Rel-17 | 1Rx/2Rx, 半双工 FDD, 最大 BW 20MHz (FR1) | 可穿戴、工业传感器、摄像头 |
| **MBS** | Rel-17 | 单小区 PTP/PTM 多播广播, 动态切换 | 公共安全、直播、OTA 升级 |

---

## 7. 标准对比

### 7.1 5G NR vs LTE vs 802.11ax (Wi-Fi 6)

| 维度 | 5G NR (Rel-17) | LTE (Rel-14) | 802.11ax (Wi-Fi 6) |
|:----|:----|:----|:----|
| **核心标准** | 3GPP TS 38 系列 | 3GPP TS 36 系列 | IEEE 802.11ax |
| **频段** | FR1: 410-7125 MHz<br>FR2: 24.25-71 GHz | 450 MHz - 3.8 GHz | 2.4/5/6 GHz (免授权) |
| **最大信道带宽** | FR1: 100 MHz<br>FR2: 400 MHz | 20 MHz (载波聚合至 640 MHz) | 160 MHz |
| **子载波间隔** | 15/30/60/120/240 kHz | 15 kHz (固定) | 78.125 kHz (固定) |
| **多址方式** | DL: CP-OFDM<br>UL: CP-OFDM / DFT-s-OFDM | DL: OFDMA<br>UL: SC-FDMA | DL+UL: OFDMA |
| **最高调制** | 1024QAM (Rel-16) | 256QAM | 1024QAM |
| **信道编码** | 数据: LDPC<br>控制: Polar | 数据: Turbo<br>控制: 卷积码 | LDPC |
| **MIMO 最大层数** | DL: 16 / UL: 8 | DL: 8 / UL: 4 | DL: 8 / UL: 8 |
| **峰值速率** | DL: ~20 Gbps<br>UL: ~10 Gbps | DL: ~3 Gbps (4x4, 5CA)<br>UL: ~1.5 Gbps | ~9.6 Gbps (8x8, 160MHz) |
| **空口延迟** | <1 ms (URLLC 0.5 ms) | ~10 ms | 5-20 ms |
| **可靠性** | 99.9999% (URLLC) | ~99% | 无硬性保证 |
| **调度单元** | Mini-slot (2/4/7 符号) | 子帧 (1 ms) | RU (Resource Unit) |
| **HARQ** | 异步自适应, 16 进程 | 同步(UL)/异步(DL), 8 进程 | MAC 层 ARQ (无 PHY HARQ) |
| **RRC 状态** | IDLE / INACTIVE / CONNECT | IDLE / CONNECT | 无 (非蜂窝, AP 关联) |
| **核心网** | 5GC (SBA 服务化) | EPC | 以太网 / IP |
| **QoS 架构** | 5QI + QoS Flow (反射式) | QCI + EPS Bearer | 802.11e EDCA / WMM |
| **网络切片** | 原生支持 | 不原生支持 (DCN 有限) | 不支持 |
| **非授权频谱** | NR-U (LBT) | LAA/eLAA | 原生免授权 |
| **覆盖范围** | 数百米 ~ 数公里 | 数百米 ~ 数公里 | 数十米 (室内为主) |
| **移动性** | <500 km/h (高铁) | <350 km/h | 步行速度 |
| **典型应用** | eMBB/URLLC/mMTC, 行业专网 | 移动宽带, VoLTE | 室内宽带, 企业 WLAN |

### 7.2 核心差异总结

| 差异点 | 说明 |
|:----|:----|
| **灵活 Numerology** | NR 引入可扩展 OFDM，一个标准框架覆盖 Sub-1GHz 到 mmWave (71 GHz) |
| **LDPC + Polar** | 替换 LTE 的 Turbo 编码，LDPC 低复杂度高吞吐，Polar 短块性能好 |
| **RRC_INACTIVE** | NR 新增中间态，兼顾低延迟 (快速恢复) 与低功耗 (无需保持 CONNECT) |
| **服务化核心网** | 5GC 采用 HTTP/2 + SBA，控制面 NF 松耦合，独立扩缩容 |
| **网络切片** | 一张物理网络虚拟化为多个逻辑专网，端到端 SLA 保障 |
| **前传标准化** | ORAN 定义了 C/U/S/M-plane 开放接口，避免传统 CPRI 的厂商锁定 |

---

## 8. 与 LTE 关键差异速查

| 维度 | LTE | NR |
|:----|:----|:---|
| 子载波间隔 | 固定 15kHz | 15/30/60/120kHz |
| 编码 | Turbo | LDPC (数据) + Polar (控制) |
| 帧结构 | 固定子帧 | 灵活 slot/symbol 级 |
| MIMO | 最大 8 层 (CRS-based) | 最大 16 层 (DMRS-based) |
| 核心网 | EPC (MME+S-GW+P-GW) | 5GC SBA (AMF+SMF+UPF) |
| RRC 态 | IDLE/CONNECT | IDLE/INACTIVE/CONNECT |
| 参考信号 | CRS 常开 (always-on) | DMRS + CSI-RS + TRS (按需) |
| 同步信道 | PSS/SSS (每5ms) | SSB 波束扫描发送 |
| BWP | 不支持 | 带宽自适应 (BWP, 最多4个) |
| 载波聚合 | PCC + SCC | PCell + SCell (含 NR-CA) |

---

## 相关文档速查

| 文档 | 路径 |
|:----|:----|
| LTE 系统概述 | [[../lte/overview]] |
| NR 帧结构 | [[nr-frame-structure]] |
| Lowphy 架构 | [[lowphy-architecture]] |
| ORAN 接口 | [[oran-interface]] |
| DFE 架构 | [[dfe-architecture]] |
| BFP 压缩 | [[bfp-compression]] |
| NR 测试模式 | [[nr-test-mode]] |

---

> 参考标准: 3GPP TS 38.300 (NR 总体描述), TS 38.331 (RRC), TS 38.211 (物理信道), TS 38.214 (物理层过程), ORAN-WG4.CUS.0
