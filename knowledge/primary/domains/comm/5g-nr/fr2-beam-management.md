# 5G NR FR2 波束管理（上） -- 基础与 SSB

> 最后更新: 2026-06-04
> 关联: [[overview]], [[nr-frame-structure]], [[../synch/algorithm_spec]]

---

## 1. FR2 概述

### 1.1 FR2 频段定义 (3GPP TS 38.104)

NR 将频率范围分为 FR1 (sub-7 GHz) 和 FR2 (mmWave)。FR2 各频段定义如下：

| NR 频段 | 别名 | 上行频率 (MHz) | 下行频率 (MHz) | 双工方式 | 典型带宽 |
|:--------|:-----|:---------------|:---------------|:---------|:---------|
| n257 | 28 GHz | 26500 - 29500 | 26500 - 29500 | TDD | 50/100/200/400 MHz |
| n258 | 26 GHz | 24250 - 27500 | 24250 - 27500 | TDD | 50/100/200/400 MHz |
| n259 | 41 GHz | 39500 - 43500 | 39500 - 43500 | TDD | 50/100/200/400 MHz |
| n260 | 39 GHz | 37000 - 40000 | 37000 - 40000 | TDD | 50/100/200/400 MHz |
| n261 | 28 GHz (US) | 27500 - 28350 | 27500 - 28350 | TDD | 50/100/200/400 MHz |

> FR2 全部采用 TDD 模式。子载波间隔 (SCS) 支持 60 kHz、120 kHz 和 240 kHz。

### 1.2 mmWave 传播特性

| 特性 | 描述 | 数值/影响 |
|:-----|:-----|:----------|
| 自由空间路径损耗 (FSPL) | 与频率平方成正比 | 28 GHz 比 3.5 GHz 高约 18 dB |
| 大气吸收 | O2 和 H2O 分子共振吸收 | 60 GHz 处峰值 ~15 dB/km |
| 雨衰 | 雨滴散射吸收 | 28 GHz 大雨 ~7 dB/km |
| 穿透损耗 | 建筑材料衰减 | 混凝土 ~175 dB, 低辐射玻璃 ~40 dB |
| 衍射能力 | 波长短，绕射差 | 28 GHz 波长 ~10.7 mm |
| 人体阻挡 | 人体遮挡损耗 | ~20-40 dB |
| 多径稀疏性 | 镜面反射为主 | 有效路径数 < FR1 |

关键结论：FR2 链路预算严重受限，必须使用波束赋形补偿路径损耗。

### 1.3 波束赋形必要性

**各向同性天线 vs 方向性天线对比**：

```
各向同性 (0 dBi):        方向性波束 (20 dBi):
    ○                          ██
   /|\                        ██████
  / | \                      ██████████
 /  ●  \                    ████  ●  ████
  \ | /                      ██████████
   \|/                        ██████
    ○                          ██
覆盖 360°, 增益 0 dBi      覆盖 ~10°, 增益 20 dBi
```

| 参数 | 各向同性 | 4x4 天线阵列 | 8x8 天线阵列 | 16x16 天线阵列 |
|:-----|:--------|:------------|:------------|:--------------|
| 阵元增益 | 0 dBi | 6 dBi | 9 dBi | 12 dBi |
| 波束宽度 (3dB) | 360 deg | ~52 deg | ~26 deg | ~13 deg |
| EIRP 提升 (vs 各向同性) | 0 dB | ~12 dB | ~18 dB | ~24 dB |

FR2 典型配置：gNB 侧 64-256 阵元，UE 侧 4-32 阵元。方向性增益弥补 mmWave 的路径损耗。

### 1.4 波束赋形架构对比

| 架构 | 原理 | 波束数 | 硬件复杂度 | 灵活性 | 典型场景 |
|:-----|:-----|:------|:----------|:------|:---------|
| **模拟波束赋形** | 移相器在 RF 域调整相位 | 1 个同时波束 | 低 (1 RF chain) | 低 | 早期 5G CPE |
| **数字波束赋形** | 基带对每阵元独立加权 | 最多 M 个同时波束 | 高 (M RF chains) | 高 | 高端 gNB |
| **混合波束赋形** | 数字预编码 + 模拟移相 | N_digital x N_analog 个 | 中 | 中 | 主流 FR2 gNB/UE |

```
模拟波束赋形:              混合波束赋形:              数字波束赋形:
RF Chain → 移相器阵列      K RF Chains → 移相器子阵    M RF Chains → M 天线
   ↓       ↓  ↓  ↓           ↓  ↓        ↓  ↓  ↓        ↓    ↓    ↓    ↓
   φ1     φ2 φ3 φ4         子阵1      子阵2 子阵K     w1   w2   w3   wM
   波束方向固定              子阵内模拟 + 子阵间数字      每个阵元独立加权
```

---

## 2. SSB 与波束扫描 (Beam Sweeping)

### 2.1 SSB 结构回顾

SSB (SS/PBCH Block) 由以下组成 (TS 38.213)：

```
      4 OFDM symbols
  ├─────────────────────┤
  ┌─────────────────────┐ ─
  │  PSS  │    PBCH     │  │
  ├───────┼──────┬──────┤  │ 20 RB
  │  SSS  │PBCH  │PBCH  │  │ (240 SC)
  ├───────┴──────┴──────┤  │
  │   PBCH (含DMRS)     │  │
  ├─────────────────────┤  │
  │   PBCH (含DMRS)     │  │
  └─────────────────────┘ ─
```

- PSS: m-sequence (N_ID2), Symbol 0
- SSS: gold-sequence (N_ID1), Symbol 2
- PBCH + DMRS: Symbols 1/2/3, 携带 MIB, DMRS 指示 SSB 索引低 3 位 (L=4) 或低 3 位 (L=8/64)

### 2.2 波束扫描原理

FR2 中，每个 SSB 与一个特定的 gNB TX 波束对应。SSB 突发集 (SS Burst Set) 内的不同 SSB 在不同时刻、不同波束方向上发射。

| 参数 | FR1 | FR2 |
|:-----|:----|:----|
| 最大 SSB 数 (L_max) | 4 或 8 | 64 |
| SSB 周期 | 5/10/20/40/80/160 ms | 5/10/20/40/80/160 ms |
| 典型配置 | 8 波束 | 64 波束 |
| SCS 对应 SSB Case | Case A/B/C | Case D/E/F |

**SSB 索引到波束方向映射示例 (L_max=64)**：

```
SSB#0  →  Beam Az=0 deg,   El=0 deg    (正前方)
SSB#1  →  Beam Az=5.6 deg, El=0 deg
SSB#2  →  Beam Az=11.2 deg,El=0 deg
  ...
SSB#63 →  Beam Az=354.4 deg,El=-45 deg  (下后方向)

每个 SSB 覆盖 ~6 deg 方位角扇区 × ~6 deg 仰角扇区
64 个 SSB 覆盖 ~120 deg 方位角 × ~45 deg 仰角 扇形范围
```

### 2.3 SSB 时域位置 -- Case D 与 Case E

**Case D: SCS = 120 kHz, FR2 (L_max=64)** (TS 38.213 Table 4.1-1)

```
5ms 半帧内 SSB 分布:

  SSB 索引 (OFDM 符号起始位置):
  0: {4,8,16,20}  + 28*n   (n=0,1,2,3,5,6,7,8,10,11,12,13,15,16,17,18)
  每个 slot (120 kHz SCS, 14 symbols) 可容纳 2 个 SSB

  Slot 布局 (120 kHz SCS):
  ├──── Slot n ────┤├──── Slot n+1 ────┤
  ┌─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┐┌─┬─┬─┬─┬─ ...
  │0│1│2│3│4│5│6│7│8│9│A│B│C│D││0│1│ ...
  └─┴─┴─┴─┴─┴─┴▲┴─┴▲┴─┴─┴─┴─┴─┘
                SSB#0  SSB#1
                (sym4)  (sym8)
```

**Case E: SCS = 240 kHz, FR2 (L_max=64)** (TS 38.213 Table 4.1-2)

```
5ms 半帧内 SSB 分布:

  SSB 索引:
  {8,12,16,20,32,36,40,44} + 56*n
  (n=0..7, 共 64 个候选位置)

  240 kHz SCS 下 slot 周期仅 62.5 us
  每个 slot (14 symbols) 可容纳 2 个 SSB
```

| Case | SCS | L_max | 5ms 半帧内 Slot 数 | 每 Slot SSB 数 | 符号起始位置 |
|:-----|:----|:------|:-------------------|:--------------|:------------|
| A | 15 kHz | 4/8 | 5 | 2 | {2,8}+14n |
| B | 30 kHz | 4/8 | 10 | 2 | {4,8}+14n |
| C | 30 kHz | 4/8 | 10 | 2 | {2,8}+14n |
| **D** | **120 kHz** | **64** | **20** | **2** | **{4,8,16,20}+28n** |
| **E** | **240 kHz** | **64** | **40** | **2** | **{8,12,16,20,32,36,40,44}+56n** |
| F | 480 kHz | 64 | 80 | 2 | 类似 Case E 扩展 |

### 2.4 gNB 波束扫描图

```
时间 →
 ┌──────────────────────────────────────────────────────┐
 │  SS Burst Set (5ms 半帧)                              │
 │                                                       │
 │  t0          t1          t2          ...    t63       │
 │  SSB#0       SSB#1       SSB#2             SSB#63    │
 │   │           │           │                 │         │
 │   ▼           ▼           ▼                 ▼         │
 │  Beam_0     Beam_1     Beam_2           Beam_63      │
 │   ╱           ╲           │               ╱           │
 │  ╱   gNB       ╲   gNB    │  gNB         ╱   gNB      │
 │ ╱               ╲         │             ╱             │
 │╱                 ╲        │            ╱              │
 │                   ╲       │           ╱               │
 │                    ╲      │          ╱                │
 │                        UE                                │
 │                        ▲                                │
 │                        │                                │
 │                      UE 在接收窗内测量所有 SSB            │
 │                      选择 RSRP 最强者                    │
 └──────────────────────────────────────────────────────┘
```

### 2.5 UE 接收波束扫描

UE 侧同样执行波束扫描：对每个 gNB TX 波束，UE 尝试不同的 RX 波束，选出最优 TX-RX 波束对。

```
       gNB TX 波束 (64 个)          UE RX 波束 (8 个)
       ╲  │  │  │  │  │  │  ╱        ╲  │  │  │  │  │  │  ╱
        ╲ │  │  │  │  │  │ ╱          ╲ │  │  │  │  │  │ ╱
         ╲│  │  │  │  │  │╱            ╲│  │  │  │  │  │╱
      ──── gNB ────               ──── UE ────

   gNB 固定 TX 波束 i          UE 轮询 RX 波束 0..7
   (SSB#i 期间)              在每个 SSB 周期测 RSRP

   最优波束对 (i*, j*) = argmax_{i,j} RSRP(i,j)
```

| 阶段 | 发射端 | 接收端 | 测量量 | 目的 |
|:-----|:------|:------|:------|:-----|
| gNB 扫描 | gNB 切换 TX 波束每 SSB | UE 准全向接收 | SS-RSRP per SSB idx | 粗选 gNB 方向 |
| UE 扫描 | gNB 固定在最优波束 | UE 切换 RX 波束 | SS-RSRP per RX beam | 精选 UE 方向 |
| 波束对建立 | 双方确定 | 双方确定 | 波束对 ID | 初始接入 |

---

## 3. 初始接入波束流程

### 3.1 流程总览

```
UE                                     gNB
 │                                      │
 │ ① 盲检 PSS/SSS (频域+时域扫描)       │
 │   检测 N_ID2, N_ID1 → PCI            │
 │                                      │
 │ ② 解码 PBCH DMRS → SSB Index (3LSB)  │
 │   解码 MIB → SFN, SCS, CORESET#0     │
 │                                      │
 │ ③ 测量所有 SSB 的 SS-RSRP            │
 │   选择最强 SSB 索引 (beam index)      │
 │                                      │
 │ ④ PRACH Preamble ──────────────────→│ 在 RO 上发送 Preamble
 │   (RO 与所选 SSB 索引关联)           │ RO 隐式指示 UE 选择的 SSB
 │                                      │
 │ ⑤                     ←──── RAR ──── │ RA-RNTI, TA, UL Grant
 │   Msg2 解码成功                      │ 确认初始波束对建立
 │                                      │
 │ ⑥ RRC Setup (Msg3/Msg4) ───────────→│ 完成连接建立
 │   波束对可用于后续 PDCCH/PDSCH       │
 │                                      │
```

### 3.2 PRACH 与 SSB 关联

UE 通过 PRACH 时机 (RO, RACH Occasion) 和 Preamble 索引向 gNB 指示所选 SSB。

| 参数 | 说明 | 示例配置 |
|:-----|:-----|:---------|
| ssb-perRACH-Occasion | 每个 RO 关联的 SSB 数 | 1/2/4/8/16 |
| msg1-FDM | 频域复用 RO 数 | 1/2/4/8 |
| PRACH Configuration Index | 时域 RO 图样 | 查表 TS 38.211 Table 6.3.3.2 |

**SSB 到 RO 映射示例 (ssb-perRACH=4, msg1-FDM=4)**：

```
频域 (FDMed)
  RO#3 ─── SSB#12..15
  RO#2 ─── SSB#8..11
  RO#1 ─── SSB#4..7
  RO#0 ─── SSB#0..3
  └── 时域 (同一个 PRACH slot) ──→

UE 测量 SSB#5 最强:
  → 在关联 SSB#4..7 的 RO#1 中发送 Preamble
  → 每个 SSB 对应 preamble 子集 (64 preamble / 4 SSB = 16 个/SSB)
  → UE 选择 preamble#37 (属于 SSB#5 的子集)
```

### 3.3 初始波束对建立

| 步骤 | 动作 | 关键参数 |
|:-----|:-----|:---------|
| 1. 小区搜索 | PSS/SSS 检测, PCI 获取 | N_ID1 (0..335), N_ID2 (0..2) |
| 2. MIB 解码 | 获取 SFN, SCS, CORESET#0, SSB 索引 | pdcch-ConfigSIB1 |
| 3. SSB 测量 | 对所有 SSB 测 SS-RSRP | 选择最强 SSB 索引 i_best |
| 4. PRACH 发送 | 在关联 RO 上发送 Preamble | ssb-perRACH, Preamble 选择 |
| 5. RAR 接收 | 解码 RA-RNTI, 获得 TA + UL Grant | RA Response Window |
| 6. RRC 连接 | Msg3/Msg4 交换 | RRCSetupRequest/Setup |

gNB 接收到指定 RO 和 Preamble 后，反推 UE 所选 SSB 索引，后续 PDCCH/PDSCH 使用相同 TX 波束发送。

---

## 4. 波束管理流程 (P1/P2/P3)

3GPP 定义了三阶段波束管理流程（TS 38.802）：

### 4.1 P1: 初始捕获 / 波束扫描

**目标**：建立初始 gNB-UE 粗波束对。

```
      gNB 广角粗波束扫描                 UE 广角粗波束扫描
       (P1-TX 波束集)                    (P1-RX 波束集)
           ╱ ╲                              ╱ ╲
          ╱   ╲                            ╱   ╲
         ╱     ╲                          ╱     ╲
        ╱  gNB  ╲                        ╱  UE   ╲

    波束宽度: 15-30 deg               波束宽度: 30-60 deg
    波束数: 8-16                      波束数: 4-8
    参考信号: SSB                     参考信号: SSB (UE RX 扫描)
```

| 参数 | gNB (P1-TX) | UE (P1-RX) |
|:-----|:-----------|:-----------|
| 波束宽度 | 15-30 deg | 30-60 deg |
| 波束数量 | 8-16 | 4-8 |
| 周期 | 20 ms (SSB 周期) | 对齐 SSB 周期 |
| 测量量 | -- | SS-RSRP |
| 输出 | gNB TX 粗波束 ID | UE RX 粗波束 ID |

### 4.2 P2: gNB 侧波束精化

**目标**：gNB 在粗波束方向附近，用更窄的波束精化发送方向。

```
      P1 粗波束方向 (15 deg)             P2 精化波束集 (5 deg each)
           ╱                                   ╱ ╱ ╱
          ╱                                   ╱ ╱ ╱
         ╱                                   ╱ ╱ ╱
        ╱                                   ╱ ╱ ╱

    gNB 在 P1 选出的粗方向附近              UE RX 波束固定于 P1 最优
    发送 4-8 个更窄的 CSI-RS 波束          上报 CRI (CSI-RS Resource Indicator)
    每个波束宽度约 5-8 deg                 选择 RSRP 最强的 CSI-RS 资源
```

| 参数 | 说明 |
|:-----|:-----|
| 参考信号 | NZP CSI-RS (周期性/半静态) |
| 波束数 | 4-8 个窄波束, 覆盖 P1 粗方向范围 |
| UE 上报 | CRI + L1-RSRP |
| 上报方式 | PUCCH/PUSCH |
| 周期 | 10-80 ms (可配) |

### 4.3 P3: UE 侧波束精化

**目标**：gNB 固定 TX 波束，UE 扫描不同 RX 波束以找到最优接收方向。

```
    gNB TX 波束固定                   UE RX 波束扫描
    (P2 选出的最优)                   (4-8 个方向)
         │                            ╱ ╱ ╱ ╱
         │                           ╱ ╱ ╱ ╱
         │                          ╱ ╱ ╱ ╱
         ▼                          ╱ ╱ ╱ ╱
       gNB                              UE

    gNB 在每个 CSI-RS 资源上         UE 对同一个 CSI-RS 资源
    重复发射相同波束                 使用不同 RX 波束接收
     (repetition = ON)             测量 RSRP, 选出最优 RX 波束
```

| 参数 | 说明 |
|:-----|:-----|
| 参考信号 | NZP CSI-RS, repetition = ON |
| CSI-RS 资源数 | 4-8 (对应 UE RX 波束数) |
| gNB 行为 | 相同 TX 波束重复发射 |
| UE 行为 | 切换 RX 波束, 测 RSRP, 选最优 |
| 上报 | 可选 (UE 内部确定 RX 波束) |

### 4.4 P1/P2/P3 完整流程图

```
┌─────────────────────────────────────────────────────────────┐
│                      波束管理 P1/P2/P3                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │   P1     │───→│   P2     │───→│   P3     │              │
│  │ 粗捕获   │    │ gNB精化  │    │ UE 精化  │              │
│  └──────────┘    └──────────┘    └──────────┘              │
│       │               │               │                    │
│       ▼               ▼               ▼                    │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                │
│  │SSB 扫描 │    │CSI-RS   │    │CSI-RS   │                │
│  │8-64 波束│    │4-8 窄束 │    │rep=ON   │                │
│  └─────────┘    └─────────┘    └─────────┘                │
│       │               │               │                    │
│       ▼               ▼               ▼                    │
│  gNB粗波束ID    gNB窄波束ID     UE 最优RX波束              │
│  UE 粗波束ID    CRI+RSRP上报    (内部确定)                 │
│                                                             │
│  输出: 精确 TX-RX 波束对 → 用于 PDCCH/PDSCH/PUCCH/PUSCH   │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Beam Indication (TCI 状态)

### 5.1 TCI 状态与 QCL 概念

TCI (Transmission Configuration Indicator) 状态向 UE 指示 PDCCH/PDSCH DMRS 与参考信号之间的 QCL 关系。UE 据此设置接收波束。

**QCL (Quasi-Co-Location) 类型** (TS 38.214 §5.1.5)：

| QCL Type | 共享的信道特性 | 用途 |
|:---------|:--------------|:-----|
| **Type A** | 多普勒频移, 多普勒扩展, 平均延迟, 延迟扩展 | 时频同步, 信道估计 |
| **Type B** | 多普勒频移, 多普勒扩展 | 仅频域同步 |
| **Type C** | 多普勒频移, 平均延迟 | 仅频偏+定时 |
| **Type D** | 空间 RX 参数 | **波束指示 (核心)** |

> Type D (空间 QCL) 是波束管理的核心：如果目标 DMRS 与源 RS 是 QCL Type D，UE 可以使用接收该源 RS 的相同 RX 波束来接收目标 DMRS。

### 5.2 TCI 状态结构

一个 TCI 状态可包含一个或两个 RS 源：

```
TCI State {
    TCI-StateId: Integer (0..127)
    qcl-Type1: {
        ReferenceSignal: SSB-index / NZP-CSI-RS-ResourceId
        qcl-Type: TypeA / TypeB / TypeC (时频参数)
    }
    qcl-Type2 (可选): {
        ReferenceSignal: SSB-index / NZP-CSI-RS-ResourceId
        qcl-Type: TypeD (空间参数, 波束方向)
    }
}
```

**典型 TCI 状态配置示例**：

| TCI State ID | QCL-Type1 (源 RS) | QCL-Type2 (源 RS) | 含义 |
|:-------------|:------------------|:------------------|:-----|
| 0 | SSB#5, TypeA | SSB#5, TypeD | 使用时频同步 + 指向 SSB#5 的波束 |
| 1 | CSI-RS#3, TypeA | CSI-RS#3, TypeD | 使用时频同步 + 指向 CSI-RS#3 的波束 |
| 2 | TRS#1, TypeA | SSB#12, TypeD | 用 TRS 做时频同步 + 指向 SSB#12 的波束 |

### 5.3 TCI 状态激活与指示流程

```
┌─────────────────────────────────────────────────────────┐
│                  TCI 状态配置/激活/选择流程                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ① RRC 配置 TCI 状态池 (最多 128 个)                      │
│     tci-StatesToAddModList: {0,1,2,...,127}             │
│                         │                               │
│                         ▼                               │
│  ② MAC-CE 激活子集 (最多 8 个, 用于 PDSCH/PDCCH)          │
│     TCI States Activation/Deactivation MAC-CE           │
│     激活 TCI#3, #17, #25, #42, #58, #63, #89, #101     │
│                         │                               │
│                         ▼                               │
│  ③ DCI 指示当前使用的 TCI 状态                             │
│     ┌──────────────────────┐                            │
│     │ PDSCH: DCI 1_1/1_2   │  TCI 字段 (3-bit)          │
│     │   指向激活子集中的索引 │  000→激活集中第1个          │
│     ├──────────────────────┤                            │
│     │ PDCCH: 每CORESET配置  │  tci-StatesPDCCH          │
│     │   MAC-CE选1个         │  MAC-CE选1个TCI状态        │
│     └──────────────────────┘                            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 5.4 TCI 状态应用场景

| 信道 | 配置方式 | 激活方式 | 选择/指示方式 | 生效延迟 |
|:-----|:--------|:--------|:------------|:---------|
| PDSCH | RRC: tci-StatesToAddModList | MAC-CE: 激活子集 | DCI 字段 0-3 bit | 下一个 slot |
| PDCCH (CORESET) | RRC: tci-StatesPDCCH-ToAddModList | MAC-CE: 每 CORESET 激活 1 个 | MAC-CE 直接选 | 3 ms 后 (TS 38.133) |
| PUCCH (空间关系) | RRC: spatialRelationInfo | MAC-CE: 激活 1 个 | MAC-CE 直接选 | 3 ms 后 |
| CSI-RS (QCL) | RRC: qcl-InfoPeriodicCSI-RS | -- | RRC 直接配 | -- |
| SRS (空间关系) | RRC: spatialRelationInfo | MAC-CE: 激活 1 个 | MAC-CE 直接选 | 3 ms 后 |

---

## 6. Beam Failure Recovery (BFR)

### 6.1 Beam Failure Detection (BFD)

| 参数 | 说明 | 典型值 |
|:-----|:-----|:-------|
| BFD-RS 集合 q0 | RRC 配置的周期性 CSI-RS 或 SSB 集 | 最多 2 个 RS |
| 失同步门限 (Q_out_LR) | 假想 PDCCH BLER > 10% | RRC 配置: rlmInSyncOutOfSyncThreshold |
| Beam Failure Instance (BFI) | 当 q0 中所有 RS 的 L1-RSRP 低于门限 | PHY 向 MAC 上报 BFI 指示 |
| beamFailureInstanceMaxCount | 连续 BFI 计数门限 | RRC 配置, 典型 4-10 |
| beamFailureDetectionTimer | BFI 计数器复位定时器 | RRC 配置 |

**BFD 流程**：

```
PHY 层评估 q0 中每个 RS:         MAC 层维护计数器:
  RS#0 L1-RSRP < threshold? ──yes──→ BFI_COUNTER++
  RS#1 L1-RSRP < threshold? ──yes──→ (仅当两者都低时上报)
                                     │
                                     ▼
                              BFI_COUNTER >= maxCount?
                                     │ no → 启动/重启 timer
                                     │ yes
                                     ▼
                              声明 Beam Failure
                              触发 BFR 流程
```

### 6.2 BFR 流程

```
UE                                       gNB
 │                                        │
 │ ① Beam Failure 声明                     │
 │   BFI_COUNTER >= beamFailureInstance   │
 │   MaxCount                             │
 │                                        │
 │ ② 候选波束检测                          │
 │   测量候选波束集 q1 (CSI-RS/SSB)        │
 │   选择 L1-RSRP > threshold 的新波束     │
 │   new_beam_id = argmax RSRP(q1)        │
 │                                        │
 │ ③ BFR-PRACH 发送 ────────────────────→│
 │   (CFRA: 专用 preamble + 专用 RO)       │ 通过专用 preamble 识别
 │   或 (CBRA: 回退到竞争 PRACH)           │ 这是 BFR 请求
 │                                        │
 │ ④ BFR Response 监听                    │
 │   在专用 CORESET 上监听                 │
 │   (recoverySearchSpaceId)              │
 │                                        │
 │ ⑤                     ←──── DCI ────── │
 │   C-RNTI 加扰 DCI,                     │ gNB 确认 BFR 完成
 │   在 recoverySearchSpace 上接收         │ 切换到新波束
 │                                        │
 │ ⑥ RRC 重配置 (可选) ─────────────────→│
 │   更新 TCI 状态为新波束                 │
 │                                        │
 │ ⑦ BFR 完成                              │
 │   恢复数据传输                          │
```

### 6.3 BFR 与初始接入 PRACH 对比

| 特性 | 初始接入 PRACH | BFR-PRACH |
|:-----|:-------------|:----------|
| 触发条件 | UE 开机/切换 | Beam Failure 声明 |
| Preamble 类型 | CBRA: 竞争 preamble | CFRA: 专用 preamble (优先) |
| RO (RACH Occasion) | 公共 RO | 专用 RO (关联新波束) |
| 响应搜索空间 | Type1-PDCCH CSS | recoverySearchSpaceId |
| 响应窗口 | ra-ResponseWindow | beamFailureRecoveryResponseWindow |
| 回退机制 | 竞争解决失败 → 重试 | CFRA 超时 → CBRA 回退 |
| RNTI | RA-RNTI (Msg2), C-RNTI/T-CRNTI (Msg4) | C-RNTI |
| 目标 | 初始接入, 建立 RRC 连接 | 快速恢复波束, 维持连接 |

### 6.4 BFR 流程图

```
┌───────────────────────────────────────────────────────────┐
│                Beam Failure Recovery 流程                  │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐ │
│  │ Beam Failure│────→│ 候选波束检测 │────→│ BFR 请求    │ │
│  │ Detection   │     │ (new beam)  │     │ (PRACH)     │ │
│  └─────────────┘     └─────────────┘     └─────────────┘ │
│        │                   │                   │         │
│        ▼                   ▼                   ▼         │
│  BFD-RS(q0)全部      测量 CSI-RS/SSB       CFRA: 专用    │
│  L1-RSRP低于门限     候选集(q1)           preamble+RO    │
│  BFI_COUNTER         选出最强RS           CBRA: 回退     │
│  ≥ maxCount           (new_beam_id)                     │
│                                                           │
│                           │                               │
│                           ▼                               │
│  ┌─────────────┐     ┌─────────────┐                     │
│  │ BFR 响应    │←────│ gNB 确认    │                     │
│  │ 接收        │     │ (DCI)       │                     │
│  └─────────────┘     └─────────────┘                     │
│        │                                                 │
│        ▼                                                 │
│  切换至新波束                                            │
│  更新 TCI 状态                                           │
│  恢复数据传输                                            │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

---

## 7. 多 TRP 波束管理 (高级)

### 7.1 mTRP 概念

多发送接收点 (Multi-TRP) 允许 UE 同时与多个地理上分离的 gNB 天线面板通信，提升可靠性和吞吐量。

```
         ┌──────────┐           ┌──────────┐
         │  TRP#1   │           │  TRP#2   │
         │ (Panel1) │           │ (Panel2) │
         └────┬─────┘           └────┬─────┘
              │  ╲               ╱   │
              │   ╲             ╱    │
              │    ╲           ╱     │
              │     ╲         ╱      │
              │      ╲       ╱       │
              │       ╲     ╱        │
              │        ╲   ╱         │
              │         ╲ ╱          │
              │          ╳           │
              │         ╱ ╲          │
              │        ╱   ╲         │
              └───────╱─────╲────────┘
                     UE
```

### 7.2 单 DCI vs 多 DCI

| 特性 | 单 DCI (sDCI) | 多 DCI (mDCI) |
|:-----|:------------|:-------------|
| 调度方式 | 一个 DCI 调度多个 TRP | 每个 TRP 独立 DCI |
| CORESET 配置 | 多个 CORESET, 1 个 CORESETPoolIndex | 每个 TRP 自己的 CORESETPoolIndex (0/1) |
| TCI 数量 | DCI 中指示 2 个 TCI | 每个 DCI 指示 1 个 TCI |
| 典型场景 | 高速移动, 可靠性优先 | 小区边缘, 容量优先 |
| UE 能力 | 需要支持 sDCI mTRP | 需要支持 mDCI mTRP |

### 7.3 多个 TCI 状态同时激活

```
单 DCI mTRP, 2 个 TCI 状态同时应用:

  DCI 1_1 (PDSCH 调度)
     │
     ├── TCI#1 → TRP#1 的 TX 波束 (QCL TypeD 指向 CSI-RS#A)
     │    └→ PDSCH Layer 0,1
     │
     └── TCI#2 → TRP#2 的 TX 波束 (QCL TypeD 指向 CSI-RS#B)
          └→ PDSCH Layer 2,3

  UE 同时维持两个 RX 波束 (2 个天线面板)
```

### 7.4 mTRP 传输方案

| 方案 | 描述 | TCI 使用 | 可靠性增益 |
|:-----|:-----|:--------|:----------|
| SDM (空分复用) | 不同 TRP 不同层 | 每 TCI 对应部分层 | 增加层数 |
| FDM (频分复用) | 不同 TRP 不同 RB | 每 TCI 对应部分 RB | 频率分集 |
| TDM (时分复用) | 不同 TRP 不同符号 | 每 TCI 对应部分符号 | 时间分集 |
| SFN (单频网) | 相同数据多 TRP 同传 | 1 个 TCI | 宏分集 |

---

## 参考文献

| 规范 | 章节 | 内容 |
|:-----|:-----|:-----|
| TS 38.211 | §7.4 | SSB 物理资源映射 |
| TS 38.213 | §4.1 | SSB 时域候选位置 |
| TS 38.213 | §13 | UE 过程 (小区搜索/MIB) |
| TS 38.214 | §5.1 | PDSCH 资源分配与 TCI |
| TS 38.214 | §5.2 | PDCCH 资源分配与 TCI |
| TS 38.321 | §5.17 | BFR MAC 过程 |
| TS 38.321 | §5.18 | BFD/BFR 定时器与计数器 |
| TS 38.133 | §8 | UE 波束管理性能要求 |
| TS 38.133 | §8.5 | BFD/BFR 时间要求 |
| TS 38.104 | §5 | FR2 频段与带宽 |
| TS 38.802 | §9 | 波束管理物理层设计 |

---

*下册预览: CSI-RS 波束管理 / CSI 上报 / 波束切换延迟 / AI/ML 波束管理*
