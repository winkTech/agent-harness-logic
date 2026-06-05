---
title: "5G NR PDSCH -- 物理下行共享信道深度解析"
tags: [comm, 5g-nr, data-channel, dmrs, harq]
description: "PDSCH (Physical Downlink Shared Channel) 是 NR 下行物理层承载用户数据和控制信息的核心信道。它承载来自 DL-SCH (Downlink Shared Channel) 传输信道的数据。"
related: [5g-nr/bfp-compression.md, 5g-nr/dfe-architecture.md, 5g-nr/fr2-beam-management.md, 5g-nr/lowphy-architecture.md, 5g-nr/mimo-detection.md, 5g-nr/nr-frame-structure.md]
---
# 5G NR PDSCH -- 物理下行共享信道深度解析

> 最后更新: 2026-06-04
> 关联: [[overview]], [[nr-frame-structure]], [[pdcch]], [[nr-ldpc]], [[mimo-detection]]

---

## 1. PDSCH 概述

### 1.1 功能定位

PDSCH (Physical Downlink Shared Channel) 是 NR 下行物理层承载用户数据和控制信息的核心信道。它承载来自 DL-SCH (Downlink Shared Channel) 传输信道的数据。

| 承载内容 | 调度标识 (RNTI) | 搜索空间类型 | 说明 |
|:---------|:---------------|:------------|:-----|
| 用户数据 (单播) | C-RNTI, MCS-C-RNTI | USS | 动态调度的 UE 专属数据 |
| SPS (半静态调度) 数据 | CS-RNTI | USS | Configured Grant Type 2 |
| 系统信息 (SIB1) | SI-RNTI | Type0-PDCCH CSS | 由 MIB 指示的 CORESET0 |
| 系统信息 (OSI) | SI-RNTI | Type0A-PDCCH CSS | 在 SI 窗口内的公共搜索空间 |
| 寻呼消息 | P-RNTI | Type2-PDCCH CSS | 寻呼时机 (PO) |
| 随机接入响应 (RAR) | RA-RNTI | Type1-PDCCH CSS | Msg2 调度 |
| MsgB (2-step RACH) | MsgB-RNTI | Type1-PDCCH CSS | 2-step RACH MsgB 调度 |

### 1.2 调度方式

| 调度方式 | 机制 | DCI Format | RNTI | 适用场景 |
|:---------|:-----|:----------|:-----|:---------|
| 动态调度 | 每 TB 一个 DCI 授权 | DCI 1_0 / 1_1 / 1_2 | C-RNTI | eMBB, URLLC, 通用数据 |
| SPS (Semi-Persistent) | RRC 配置周期 + DCI 激活/释放 | DCI 1_0 / 1_1 (CS-RNTI) | CS-RNTI | VoIP, V2X, 周期性小包 |
| Configured Grant (DL) | 等同 SPS，无 DCI 每 TB | DCI 1_0 / 1_1 激活后免调度 | CS-RNTI | 工业 IoT, 确定性低延迟 |

### 1.3 PDSCH 与 PDCCH 的时序关系 (K0)

K0 定义 PDCCH 所在时隙到其调度的 PDSCH 时隙的偏移量 (以时隙为单位)。K0 = 0 表示 PDSCH 与 PDCCH 在同一时隙内 (同隙调度)。

```
时隙 n (PDCCH)                    时隙 n + K0 (PDSCH)
┌─────────────────┐              ┌─────────────────┐
│  CORESET         │              │                  │
│  ┌───┐           │              │  PDSCH (SLIV)    │
│  │DCI│  K0 slots │              │  ┌───────────┐   │
│  └───┘───────────┼─────────────→│  │ DL-SCH TB │   │
│                  │              │  └───────────┘   │
└─────────────────┘              └─────────────────┘
```

| 参数 | 取值范围 | RRC 配置 | 说明 |
|:-----|:---------|:--------|:-----|
| K0 | 0 ~ 32 | `PDSCH-TimeDomainResourceAllocation` | 时隙级偏移 |
| K0 用于 DCI 1_0 | 0 | 固定 (CSS) | CSS 中的 DCI 1_0 固定 K0=0 |

---

## 2. 频域资源分配

### 2.1 分配类型总览

NR 频域资源分配在 BWP (Bandwidth Part) 内进行，支持三种类型 (后两种常合并讨论):

| 属性 | Type 0 | Type 1 | Type 2 (DCI 1_0 fallback) |
|:-----|:------|:------|:--------------------------|
| 分配方式 | RBG bitmap | RIV (起始 + 长度) | 固定起始 + 连续分配 |
| 粒度 | 每 RBG 1 bit | 每 VRB 级 | 每 VRB 级 |
| 灵活性 | 高 (非连续分配) | 中 (仅连续分配) | 低 (固定模式) |
| DCI 开销 | 高 (bitmap 长度 = N_RBG) | 低 (ceil(log2(N*(N+1)/2))) | 最低 |
| 适用 DCI | DCI 1_1, 1_2 | DCI 1_1, 1_2 | DCI 1_0 (fallback) |
| 典型场景 | MU-MIMO, 频谱碎片整理 | eMBB, URLLC (低开销) | 初始接入, SIB, Paging |

### 2.2 Type 0: RBG Bitmap

**RBG (Resource Block Group)** 是 Type 0 分配的基本粒度。一个 RBG 包含 P 个连续的 VRB。

| BWP 大小 (RB) | 配置 1 P | 配置 2 P |
|:-------------|:--------|:--------|
| 1 ~ 36 | 2 | 4 |
| 37 ~ 72 | 4 | 8 |
| 73 ~ 144 | 8 | 16 |
| 145 ~ 275 | 16 | 16 |

- 配置通过 RRC `rbg-Size` (config1 / config2) 选择
- bitmap 长度 N_RBG = ceil(N_BWP_size / P)
- bitmap 中的 bit 对应 RBG，bit = 1 表示该 RBG 分配给 PDSCH

```
例: BWP = 100 RB, 配置 1 → P = 8, N_RBG = ceil(100/8) = 13
    bitmap: [1 1 0 0 1 0 0 0 0 1 1 0 0]  → 分配 RBG 0,1,4,9,10
                                    (共 40 RB, 非连续)
```

### 2.3 Type 1: RIV (Resource Indication Value)

通过单个 RIV 值编码起始 RB (S) 和连续分配长度 (L_RB)。

**RIV 编码公式** (3GPP TS 38.214 §5.1.2.2.2):

```
RIV = N_BWP_size × (L_RB - 1) + S             当 (L_RB - 1) ≤ floor(N_BWP_size / 2)
RIV = N_BWP_size × (N_BWP_size - L_RB + 1) + (N_BWP_size - 1 - S)  否则
```

其中:
- S: 起始 VRB 索引 (0 ≤ S ≤ N_BWP_size - 1)
- L_RB: 连续 RB 数量 (1 ≤ L_RB ≤ N_BWP_size - S)
- DCI bit 宽度: ceil(log2(N_BWP_size × (N_BWP_size + 1) / 2))

| BWP RB 数 | DCI bit 宽度 | 编码范围 |
|:---------|:------------|:--------|
| 24 | 9 | 0 ~ 299 |
| 48 | 11 | 0 ~ 1175 |
| 100 | 13 | 0 ~ 5049 |
| 273 | 16 | 0 ~ 37362 |

### 2.4 Type 2: DCI 1_0 Fallback 资源分配

DCI 1_0 (fallback DCI) 中频域资源分配使用截断的 RIV 公式，适用于 CSS (公共搜索空间) 场景:

- DCI 1_0 在 CSS 中: 频域资源分配 bit 宽度由 CORESET0 大小 (或初始 DL BWP，如果配置) 决定
- DCI 1_0 在 USS 中: 使用激活 DL BWP 大小
- 分配始终连续，无 bitmap 模式
- 当 DCI 1_0 在 CSS 中且 SI-RNTI 加扰: 频域资源起始位置由 DCI 字段指示，固定从 CORESET0 的 RB 范围内分配

**DCI 1_0 fallback 频域分配 bit-width 计算**:

| 场景 | BW 参考 | bit width |
|:----|:-------|:---------|
| CSS, CORESET0 未配置初始 DL BWP | CORESET0 带宽 | ceil(log2(N_CORESET0_RB × (N_CORESET0_RB + 1) / 2)) |
| CSS, 已配置 initial DL BWP | initial DL BWP 带宽 | ceil(log2(N_init_BWP_RB × (N_init_BWP_RB + 1) / 2)) |
| USS | 激活 DL BWP 带宽 | ceil(log2(N_act_BWP_RB × (N_act_BWP_RB + 1) / 2)) |

### 2.5 各 Type 适用场景对比

| 场景 | 推荐 Type | 理由 |
|:-----|:---------|:-----|
| 初始接入 (SIB1/RAR/Msg4) | Type 2 (DCI 1_0) | 无需 RRC 配置，标准化 fallback |
| 通用数据 (eMBB) | Type 1 | RIV 节省 DCI 开销，支持宽带连续分配 |
| MU-MIMO / 频谱碎片 | Type 0 | bitmap 支持非连续分配，灵活隔离用户 |
| URLLC mini-slot | Type 1 | RIV 低开销，适应小 BW 分配 |
| SPS 激活 | Type 1 或 Type 0 | 取决于 RRC 配置 `resourceAllocation` |

### 2.6 VRB-to-PRB 映射

| 映射类型 | 机制 | 适用场景 |
|:---------|:-----|:---------|
| 非交织 (Non-interleaved) | VRB n 直接映射到 PRB n | 频选调度 (子带 CSI 反馈) |
| 交织 (Interleaved) | VRB bundle 按交织器映射到 PRB | 频率分集 (无 CSI 反馈时) |

交织器: RB bundle 大小为 2 (由 RRC `vrb-ToPRB-Interleaver` 配置)，在 BWP 内按行写列读方式交织。

---

## 3. 时域资源分配

### 3.1 时域分配参数

PDSCH 时域分配由 RRC 配置表 `PDSCH-TimeDomainResourceAllocationList` (或默认表) 确定。

| 参数 | 含义 | 取值范围 |
|:-----|:-----|:---------|
| **K0** | PDCCH→PDSCH 时隙偏移 | 0 ~ 32 |
| **mappingType** | 映射类型 | Type A / Type B |
| **startSymbolAndLength (SLIV)** | 起始符号 S + 长度 L | 编码值 (0 ~ 103) |

### 3.2 Mapping Type A vs Type B

| 属性 | Type A | Type B |
|:-----|:------|:------|
| 首个 DMRS 符号位置 | 符号 2 或 3 (由 MIB `dmrs-TypeA-Position` 指示) | PDSCH 分配的第一个符号 |
| PDSCH 起始符号范围 | 符号 0 ~ 3 | 符号 2 ~ 13 |
| PDSCH 长度范围 | 3 ~ 14 符号 (含 DMRS) | 2, 4, 7 符号; 或 2 ~ 14 (部分配置) |
| 调度粒度 | 时隙级 (slot-based) | 符号级 (mini-slot) |
| 典型场景 | eMBB 宽带数据 | URLLC 低延迟 |
| 跨时隙边界 | 不允许 (限于 1 时隙内) | 不允许 (限于 1 时隙内) |

**Type A 示例** (pos2, S=2, L=12):

```
时隙 (14 OFDM 符号)
┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │11 │12 │13 │
│   │   │DM │DM │   │   │   │   │   │   │   │   │   │   │
│   │   │RS │RS │   │   │   │   │   │   │   │   │   │   │
│   │   │ ▲ │   │   │   │   │   │   │   │   │   │   │   │
│←─PDCCH──→├─── PDSCH (S=2, L=12) ────────────────────→│
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
```

**Type B 示例** (mini-slot, S=8, L=4):

```
时隙 (14 OFDM 符号)
┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │11 │12 │13 │
│   │   │   │   │   │   │   │   │DM │   │   │   │   │   │
│   │   │   │   │   │   │   │   │RS │   │   │   │   │   │
│   │   │   │   │   │   │   │   │ ▲ │   │   │   │   │   │
│   │   │   │   │   │   │   │   │←─ PDSCH (S=8, L=4) ─→│
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
```

### 3.3 SLIV 编码

SLIV (Start and Length Indicator Value) 将起始符号 S 和连续长度 L 编码为单一数值。

**编码公式** (3GPP TS 38.214 §5.1.2.1):

```
SLIV = 14 × (L - 1) + S                      当 (L - 1) ≤ 7
SLIV = 14 × (14 - L + 1) + (14 - 1 - S)      当 (L - 1) > 7
```

| S | L | 条件 | SLIV |
|:-:|:-:|:-----|:----:|
| 0 | 14 | L-1=13 > 7, 第二公式 | 14×(14-14+1)+(13-0)=14+13=27 |
| 2 | 12 | L-1=11 > 7, 第二公式 | 14×(14-12+1)+(13-2)=42+11=53 |
| 8 | 4 | L-1=3 ≤ 7, 第一公式 | 14×(4-1)+8=42+8=50 |
| 3 | 11 | L-1=10 > 7, 第二公式 | 14×(14-11+1)+(13-3)=56+10=66 |

### 3.4 默认时域分配表 (未配置 RRC 时)

| 行索引 | mappingType | K0 | S | L |
|:------|:-----------|:--|:-:|:-:|
| 1 | Type A | 0 | 2 | 12 |
| 2 | Type A | 0 | 3 | 11 |
| 3 | Type A | 0 | 2 | 10 |
| 4 | Type A | 0 | 3 | 9 |
| 5 | Type A | 0 | 2 | 7 |
| 6 | Type A | 0 | 3 | 6 |
| 7 | Type A | 0 | 2 | 5 |
| 8 | Type A | 0 | 3 | 4 |
| 9 | Type B | 0 | 9 | 4 |
| 10 | Type B | 0 | 4 | 4 |
| 11 | Type B | 0 | 6 | 4 |
| 12 | Type B | 0 | 8 | 4 |
| 13 | Type B | 0 | 10 | 4 |
| 14 | Type B | 0 | 5 | 7 |
| 15 | Type B | 0 | 6 | 2 |
| 16 | Type B | 0 | 9 | 2 |

- 默认 K0 = 0 (同隙调度)，适用于 SCS = 15/30 kHz
- RRC 可覆盖此默认表

---

## 4. DMRS (解调参考信号)

### 4.1 DMRS 配置类型

PDSCH DMRS 用于下行信道估计和解调。NR 定义两种 DMRS 配置类型。

| 属性 | DMRS Type 1 | DMRS Type 2 |
|:-----|:-----------|:-----------|
| 频域复用方式 | Comb-2 + CS (Cyclic Shift) | FD-OCC (Frequency Domain OCC) |
| 每 RB RE 数 | 6 RE/端口 (1/3 密度) | 6 RE/端口 (1/2 密度) |
| CDM 组数 | 2 | 3 |
| 最大端口数 (单符号) | 4 | 6 |
| 最大端口数 (双符号) | 8 | 12 |
| 频域密度 | 偶/奇数子载波各半 | 连续 2 子载波为一组 |
| 适用场景 | SU-MIMO (1~4 层) | MU-MIMO (更多正交端口) |

### 4.2 DMRS 符号位置

**Type A Position** (由 MIB `dmrs-TypeA-Position` 广播):

| Position | DMRS 起始符号 | 含义 |
|:---------|:------------|:-----|
| pos2 | 符号 2 (l0 = 2) | 默认，PDCCH 占用 0~1 符号时使用 |
| pos3 | 符号 3 (l0 = 3) | PDCCH 占用 0~2 符号时使用 |

**附加 DMRS (Additional DMRS)**: `dmrs-AdditionalPosition` 控制额外 DMRS 符号数量 (addPos)。

| addPos | 额外 DMRS 符号数 | 适用场景 |
|:------|:---------------|:---------|
| 0 (pos0) | 0 | 低多普勒 (静止/步行) |
| 1 (pos1) | 1 | 中低多普勒 (30 km/h) |
| 2 (pos2) | 2 | 中高多普勒 (120 km/h) |
| 3 (pos3) | 3 | 高多普勒 (500 km/h, HST) |

**Type A, pos2, addPos=2 示例**:

```
时隙 (14 OFDM 符号)
┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │11 │12 │13 │
│   │   │DM │   │   │   │DM │   │   │   │DM │   │   │   │
│   │   │RS │   │   │   │RS │   │   │   │RS │   │   │   │
│   │   │ ▲ │   │   │   │ ▲ │   │   │   │ ▲ │   │   │   │
│   │   │l0 │   │   │   │l1 │   │   │   │l2 │   │   │   │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
```

### 4.3 DMRS Type 1 RE Pattern

单个 RB 内的 DMRS RE 分布 (单符号, 端口 1000/1001):

```
子载波 (频域)
 ↑
11│ D (p1001)              ← Comb 2, 奇数子载波 = 端口 1001
10│
 9│ D (p1000)              ← Comb 2, 偶数子载波 = 端口 1000
 8│
 7│ D (p1001)
 6│
 5│ D (p1000)
 4│
 3│ D (p1001)
 2│
 1│ D (p1000)
 0│
  └─────────────────→ OFDM 符号
     l0 (DMRS 符号)

CS (Cyclic Shift) 在码域区分端口:
- CDM Group 0: 端口 1000/1001 (comb 0), 端口 1004/1005 (comb 1)
- CDM Group 1: 端口 1002/1003 (comb 0), 端口 1006/1007 (comb 1)
```

### 4.4 DMRS Type 2 RE Pattern

单个 RB 内的 DMRS RE 分布 (单符号, 端口 1000/1001):

```
子载波 (频域)
 ↑
11│
10│ D (p1000/1001)         ← CDM Group 0: 子载波 0,1,6,7
 9│ D (p1000/1001)
 8│
 7│ D (p1000/1001)
 6│ D (p1000/1001)
 5│
 4│ D (p1002/1003)         ← CDM Group 1: 子载波 2,3,8,9
 3│ D (p1002/1003)
 2│ D (p1002/1003)
 1│ D (p1002/1003)
 0│
  └─────────────────→ OFDM 符号
     l0 (DMRS 符号)

FD-OCC (w_f) 在子载波对之间正交:
- w_f = [+1 +1] → 端口 1000 (CDM group 0)
- w_f = [+1 -1] → 端口 1001 (CDM group 0)
```

### 4.5 DMRS 天线端口映射

| DMRS 端口 | CDM Group | DMRS Type | 复用方式 |
|:---------|:---------|:---------|:---------|
| 1000 | 0 | Type 1 | Comb 2 偶 + CS 0 |
| 1001 | 0 | Type 1 | Comb 2 偶 + CS 1 |
| 1002 | 1 | Type 1 | Comb 2 奇 + CS 0 |
| 1003 | 1 | Type 1 | Comb 2 奇 + CS 1 |
| 1000 | 0 | Type 2 | FD-OCC [+1 +1] |
| 1001 | 0 | Type 2 | FD-OCC [+1 -1] |
| 1002 | 1 | Type 2 | FD-OCC [+1 +1] |
| 1003 | 1 | Type 2 | FD-OCC [+1 -1] |
| 1004 | 2 | Type 2 | FD-OCC [+1 +1] |
| 1005 | 2 | Type 2 | FD-OCC [+1 -1] |

### 4.6 DMRS Configuration Type 选择建议

| 场景 | 推荐类型 | 理由 |
|:-----|:---------|:-----|
| SU-MIMO 1~4 层 | Type 1 | 较低 DMRS 开销，足够正交端口 |
| SU-MIMO 5~8 层 | Type 1 (双符号) | 双符号支持 8 端口 |
| MU-MIMO 多用户配对 | Type 2 | 提供 12 个正交端口，降低用户间干扰 |
| 高频段 (FR2, > 6 GHz) | Type 1 或 Type 2 | 取决于 beam 数量和 MU-MIMO 需求 |

---

## 5. PDSCH 处理流程

### 5.1 完整处理链

```
┌─────────────┐
│ 传输块 (TB)  │  ← DL-SCH MAC PDU (含 MAC CE + RLC PDU)
│  TBS, MCS   │
└──────┬──────┘
       │ CRC 附加 (24-bit CRC)                    [TS 38.212 §5.1]
       ▼
┌─────────────┐
│ 码块分段      │  ← TBS > 3824 时触发 (BGI) / > 8448 (BG2)
│ CB + CRC     │     每码块附加 24-bit CRC
└──────┬──────┘
       │                                          [TS 38.212 §5.2]
       ▼
┌─────────────┐
│ LDPC 编码     │  ← BG1 (大 TB, 高码率) / BG2 (小 TB, 低码率)
│ BG1 / BG2   │     提升因子 Zc (2^a × j), a∈{2..7}, j∈{0..7}
└──────┬──────┘
       │                                          [TS 38.212 §5.4]
       ▼
┌─────────────┐
│ 速率匹配      │  ← 按冗余版本 RV 选择起始位置 k0
│ RV 0/1/2/3  │     LBRM (Limited Buffer Rate Matching)
└──────┬──────┘
       │                                          [TS 38.212 §5.4.2]
       ▼
┌─────────────┐
│ 码块级联      │  ← 将所有速率匹配后的码块串接为一个码字
│ Concatenation│
└──────┬──────┘
       │ 码字 (codeword)                          [TS 38.211 §7.3.1.1]
       ▼
┌─────────────┐
│ 加扰          │  ← 加扰序列 c_init = n_RNTI × 2^15 + n_ID
│ Scrambling   │     Gold 序列, 长度 31
└──────┬──────┘
       │                                          [TS 38.211 §7.3.1.2]
       ▼
┌─────────────┐
│ 调制          │  ← QPSK / 16QAM / 64QAM / 256QAM / 1024QAM
│ Modulation   │     (1024QAM 仅 DL, 需 UE 能力上报)
└──────┬──────┘
       │ 调制符号                                  [TS 38.211 §7.3.1.3]
       ▼
┌─────────────┐
│ 层映射        │  ← 1 码字 → 1~4 层 (单码字)
│ Layer Map    │     2 码字 → 5~8 层 (双码字, 仅部分配置)
└──────┬──────┘
       │                                          [TS 38.211 §7.3.1.4]
       ▼
┌─────────────┐
│ 天线端口映射   │  ← 层 × 预编码矩阵 W → 天线端口
│ Precoding    │     Non-codebook (DMRS 透明预编码)
└──────┬──────┘
       │ 每个天线端口的复值符号                    [TS 38.211 §7.3.1.5]
       ▼
┌─────────────┐
│ RE 映射       │  ← 将复值符号映射到分配的 VRB
│ VRB → PRB    │     跳过 DMRS/CSI-RS/PT-RS/SSB RE
└──────┬──────┘
       │                                          [TS 38.211 §7.3.1.6]
       ▼
┌─────────────┐
│ OFDM 生成     │  ← IFFT + CP 插入
│ (发射机)      │     SCS: 15/30/60/120/240 kHz
└─────────────┘
```

### 5.2 调制方式

| 调制方式 | 每符号 bits | 适用 MCS 表 | 最大频谱效率 (bps/Hz) | 适用 SNR |
|:---------|:----------|:----------|:-------------------|:---------|
| QPSK | 2 | Table 5.1.3.1-1/2/3 | ~1.57 | 低 SNR (小区边缘) |
| 16QAM | 4 | Table 5.1.3.1-1/2/3 | ~3.14 | 中 SNR |
| 64QAM | 6 | Table 5.1.3.1-1/2/3 | ~4.71 | 中高 SNR |
| 256QAM | 8 | Table 5.1.3.1-1/2/3 | ~6.29 | 高 SNR (小区中心) |
| 1024QAM | 10 | Table 5.1.3.1-3 (仅 DL) | ~7.86 | 极高 SNR (UE 能力) |

MCS 表说明:
- **Table 1** (`qam64`): 最高 64QAM, 基础表
- **Table 2** (`qam256`): 最高 256QAM, 低频谱效率偏移
- **Table 3** (`qam64LowSE`): 最高 64QAM, 低频谱效率 (URLLC 高可靠性)

### 5.3 码字到层映射

| 层数 | 码字数 | 映射方式 | 备注 |
|:---:|:-----:|:---------|:-----|
| 1 | 1 | x(i) = d(i) | 单层直通 |
| 2 | 1 | [x0 x1]^T = [d(2i) d(2i+1)]^T | 交替分配 |
| 3 | 1 | [x0 x1 x2]^T = [d(3i) d(3i+1) d(3i+2)]^T | 交替分配 |
| 4 | 1 | [x0 x1 x2 x3]^T = [d(4i) ... d(4i+3)]^T | 交替分配 |
| 5 | 2 | CW0→2层, CW1→3层 | 双码字 |
| 6 | 2 | CW0→3层, CW1→3层 | 双码字 |
| 7 | 2 | CW0→3层, CW1→4层 | 双码字 |
| 8 | 2 | CW0→4层, CW1→4层 | 双码字 |

### 5.4 LDPC BG 选择

| 条件 | BG1 | BG2 |
|:-----|:---|:---|
| 码率 (R) | R > 2/3 (或 R > 1/4 且 TBS > 292) | R ≤ 1/4 (或 R ≤ 2/3 且 TBS ≤ 3824) |
| TBS | 大 TB (eMBB) | 小 TB (URLLC, IoT) |
| 基矩阵大小 | 46 × 68 | 42 × 52 |
| 最大信息比特 K_max | 8448 | 3840 |
| 提升因子集合 | Set 1 (a=2): 2,4,8,16,32,64,128,256 | Set 2 (a=7): 3,6,12,24,48,96,192,384, 等 |

---

## 6. SIB 与 Paging 调度

### 6.1 SIB1 调度

SIB1 (System Information Block 1) 是 NR 小区系统信息的核心块，承载接入所需的完整 SI 配置。

| 属性 | 值 | 说明 |
|:-----|:--|:-----|
| PDCCH 搜索空间 | Type0-PDCCH CSS | 由 MIB `pdcch-ConfigSIB1` 指示 |
| PDCCH CORESET | CORESET0 | 由 MIB `controlResourceSetZero` 指示 |
| 调度 RNTI | SI-RNTI (0xFFFF) | 系统信息 RNTI |
| DCI Format | DCI 1_0 | fallback DCI |
| 调度周期 | 160 ms (默认), 可配置 80/160/320/640 ms | SIB1 在偶数 SFN 的特定时隙 |
| 频域起始 | 由 DCI 或默认表确定 | 从 CORESET0 的 VRB 范围分配 |

**SIB1 时域位置**: 由 `ssb-PositionsInBurst` 和 `pdcch-ConfigSIB1` 中的 `searchSpaceZero` 字段确定 SIB1 的 PDCCH monitoring occasion 所在的时隙和起始符号。PDSCH 的时域位置由 DCI 1_0 (SI-RNTI) 中的 `Time domain resource assignment` 字段 (4 bits) 指示，对应默认 PDSCH 时域分配表。

### 6.2 SI Message (OSI) 调度

SIB1 之外的系统信息块 (SIB2 ~ SIB9) 以 SI (System Information) message 形式广播。

| 属性 | 值 | 说明 |
|:-----|:--|:-----|
| PDCCH 搜索空间 | Type0A-PDCCH CSS | 由 SIB1 中 `searchSpaceOtherSystemInformation` 配置 |
| 调度 RNTI | SI-RNTI | 与 SIB1 相同 |
| SI 窗口长度 | si-WindowLength (5/10/20/40/80/160/320 ms) | 每个 SI message 的调度窗口 |
| 调度周期 | si-Periodicity (8/16/32/64/128/256/512 rf) | 每个 SI message 的重复周期 |

```
SI-Periodicity = 16 个无线帧 (160 ms), si-WindowLength = 40 ms

无线帧:  SFN=0         SFN=16        SFN=32        SFN=48
         ├──SI窗口────┤              ├──SI窗口────┤
         0          40 ms            0          40 ms
         ┌─┬─┬─┬─┬─┐                 ┌─┬─┬─┬─┬─┐
         │ │S│ │S│ │   ← 窗口内的     │ │S│ │S│ │
         │ │I│ │I│ │      PDCCH MUO   │ │I│ │I│ │
         └─┴─┴─┴─┴─┘                 └─┴─┴─┴─┴─┘
         发送 SI message              下一个周期
```

### 6.3 Paging 调度

| 属性 | 值 | 说明 |
|:-----|:--|:-----|
| PDCCH 搜索空间 | Type2-PDCCH CSS | 由 SIB1 中 `pagingSearchSpace` 配置 |
| 调度 RNTI | P-RNTI (0xFFFE) | 寻呼 RNTI |
| DCI Format | DCI 1_0 | fallback DCI |
| Paging Occasion (PO) | PDCCH monitoring occasion 集合 | 可能包含多个 PDCCH MUO |
| Paging Frame (PF) | 包含 PO 的无线帧 | 由寻呼参数确定 |

**PF/PO 计算** (3GPP TS 38.304 §7.1):

```
PF (SFN) 满足:
  (SFN + PF_offset) mod T = (T div N) × (UE_ID mod N)

PO 索引 (i_s):
  i_s = floor(UE_ID / N) mod Ns
```

| 参数 | RRC 配置 | 含义 |
|:-----|:--------|:-----|
| T | `defaultPagingCycle` (32/64/128/256 rf) | UE 寻呼周期 (DRX cycle 和默认周期中最小值) |
| N | min(T, nAndPagingFrameOffset 中的 n) | T 内的 PF 总数 |
| Ns | nAndPagingFrameOffset 中的 ns | PF 内的 PO 数 |
| PF_offset | nAndPagingFrameOffset 中的 PF_offset | PF 偏移 |
| UE_ID | 5G-S-TMSI mod 1024 | UE 标识 |

**nAndPagingFrameOffset 配置**:

| 配置 | n (PF 密度) | PF_offset |
|:----|:----------|:---------|
| oneT | T | 0 |
| halfT | T/2 | 0 或 T/2 |
| quarterT | T/4 | 0 ~ T × 3/4 |
| oneEighthT | T/8 | 0 ~ T × 7/8 |
| oneSixteenthT | T/16 | 0 ~ T × 15/16 |

### 6.4 SIB/Paging 频域资源分配特殊处理

SIB1/OSI/Paging 均由 DCI 1_0 (在 CSS 中) 调度，频域资源分配遵循以下规则:

1. **VRB-to-PRB 映射**: 默认非交织
2. **频域分配 bit 宽度**: 由 CORESET0 大小 (SIB1) 或 initial DL BWP (OSI, Paging) 决定
3. **DCI 1_0 中频域分配字段大小**:

   ```
   N_RB_DL_BWP = CORESET0 RB 数 (SIB1 场景)
   N_RB_DL_BWP = initial DL BWP RB 数 (OSI / Paging 场景)
   FDRA bit width = ceil(log2(N_RB_DL_BWP × (N_RB_DL_BWP + 1) / 2))
   ```

4. **分配限制**: DCI 1_0 调度的 PDSCH 不能跨越 CORESET0 (或 initial DL BWP) 的频域边界

---

## 7. HARQ

### 7.1 NR PDSCH HARQ 机制

NR PDSCH 采用异步自适应 HARQ (Asynchronous Adaptive HARQ):

| 属性 | 值 | 说明 |
|:-----|:--|:-----|
| HARQ 类型 | 异步 (Asynchronous) | 重传可在任意时刻发生，由 DCI 显式调度 |
| 自适应 | 是 (Adaptive) | 每次重传的频域/时域/MCS 可不同 |
| DL HARQ 进程数 | 最多 16 | RRC `nrofHARQ-ProcessesForPDSCH` (默认 8) |
| 冗余版本 (RV) | 0, 1, 2, 3 | 指示速率匹配中不同起始位置 |
| 软合并方式 | Chase Combining 或 IR (Incremental Redundancy) | IR 提供更高合并增益 |
| HARQ-ACK 反馈 | PUCCH (format 0/1/2/3/4) 或 PUSCH | 1~2 bits/进程 |

### 7.2 HARQ 时序 (K1)

**K1** 定义 PDSCH 结束符号到 HARQ-ACK 传输的时隙偏移 (以时隙为单位)。

```
时隙 n (PDSCH)                       时隙 n + K1 (HARQ-ACK)
┌─────────────────┐                  ┌──────────────────┐
│ PDSCH (结束时隙)  │   K1 个时隙      │ PUCCH / PUSCH     │
│                  │───────────────→ │ HARQ-ACK bits    │
└─────────────────┘                  └──────────────────┘
```

| K1 确定方式 | 场景 | 说明 |
|:-----------|:-----|:-----|
| DCI 中的 `PDSCH-to-HARQ_feedback timing indicator` (3 bits) | 动态调度 | 指向 RRC 配置的 `dl-DataToUL-ACK` 表的条目 |
| DCI 1_0 中的默认值 | fallback | K1 由 DCI 中 3-bit 字段按默认表确定 |
| `dl-DataToUL-ACK` 表 | RRC 配置 | 可配置最多 8 个 K1 值 |

**默认 K1 表** (DCI 1_0 场景):

| DCI 字段值 | K1 (时隙) |
|:---------|:----------|
| 000 | 1 |
| 001 | 2 |
| 010 | 3 |
| 011 | 4 |
| 100 | 5 |
| 101 | 6 |
| 110 | 7 |
| 111 | 8 |

### 7.3 冗余版本 (RV)

LDPC 速率匹配中，RV 决定从循环缓冲区 (circular buffer) 的哪个位置开始选择比特。IR (增量冗余) 模式下，不同 RV 发送不重叠的编码比特，HARQ 合并后可获得更大的编码增益。

| RV | k0 (循环缓冲区起始位置) | 典型使用 |
|:--:|:---------------------|:---------|
| 0 | 0 (从信息比特区起始) | 首传 (self-decodable) |
| 1 | 约 1/4 处 | 首次重传 |
| 2 | 约 1/2 处 | 第二次重传 |
| 3 | 约 3/4 处 | 第三次重传 |

**RV 序列配置** (RRC `rv-Sequence`): 可配置的 RV 序列如 `{0, 2, 3, 1}` 或 `{0, 3, 0, 3}`，对应首传及后续重传的 RV 顺序。

```
循环缓冲区:
┌──────────────┬──────────────┬──────────────┬──────────────┐
│              │              │              │              │
│    RV=0      │    RV=1      │    RV=2      │    RV=3      │
│   k0=0       │  k0≈Ncb/4   │  k0≈Ncb/2   │  k0≈3Ncb/4  │
│              │              │              │              │
└──────────────┴──────────────┴──────────────┴──────────────┘
              Ncb (循环缓冲区长度)
```

### 7.4 HARQ-ACK 码本

| HARQ-ACK 码本类型 | 说明 | 适用场景 |
|:-----------------|:-----|:---------|
| Type-1 (半静态) | 固定大小，基于 RRC 配置的候选 PDSCH 时机 | 可靠性优先，DCI 漏检不导致码本大小不匹配 |
| Type-2 (动态) | DAI (Downlink Assignment Index) 计数，动态大小 | 效率优先，减少冗余 ACK/NACK 开销 |
| Type-3 (增强动态) | 支持单次触发所有 HARQ 进程反馈 (One-shot) | 省电/URLLC, RRC `pdsch-HARQ-ACK-CodebookList` |

**DAI (Downlink Assignment Index)** 用于 Type-2 码本:
- Counter DAI (C-DAI): 当前 PDCCH monitoring occasion 内的调度计数
- Total DAI (T-DAI): 截至当前 PDCCH monitoring occasion 的总调度数 (含跨载波)

### 7.5 HARQ 进程管理

| 参数 | 取值范围 | 说明 |
|:-----|:-------|:-----|
| HARQ Process ID | 0 ~ 15 (最多 16) | DCI 1_0: 4-bit; DCI 1_1: 4-bit |
| NDI (New Data Indicator) | 0 或 1 | 翻转表示新传 |
| RV | 0 ~ 3 | 2 bits |
| HARQ-ACK 反馈类型 | ACK / NACK / DTX | DTX 表示 UE 未检测到 PDCCH |

**异步 HARQ 重传流程**:

```
gNB                                                        UE
 │                                                          │
 │── DCI (NDI=0, RV=0, HPID=x, K1=4) ───────────────────→ │ 首传
 │── PDSCH (TB, RV=0) ──────────────────────────────────→ │
 │                                                          │── 译码失败 → NACK
 │←── PUCCH (HARQ-ACK = NACK) ──────────────────────────── │
 │                                                          │
 │── DCI (NDI=0, RV=2, HPID=x, K1=3) ───────────────────→ │ 重传
 │── PDSCH (TB, RV=2) ──────────────────────────────────→ │
 │                                                          │── 软合并 → 译码成功 → ACK
 │←── PUCCH (HARQ-ACK = ACK) ───────────────────────────── │
 │                                                          │
 │── DCI (NDI=1, RV=0, HPID=x, K1=4) ───────────────────→ │ 新传
 │── PDSCH (new TB)  ────────────────────────────────────→│
```

### 7.6 LBRM (Limited Buffer Rate Matching)

为限制 UE 译码器缓冲区大小，NR 定义 LBRM:

| 参数 | 含义 | 典型值 |
|:-----|:-----|:------|
| N_ref | 参考 TBS (用于 LBRM) | 基于最大层数、最大调制阶数、最大 PRB 数 |
| N_cb | 每码块的循环缓冲区长度 | min(N, N_ref) |
| UE 能力 | `maxNumberMIMO-LayersPDSCH` + `supportedModulationOrderDL` | 决定 N_ref 计算基准 |

LBRM 确保 UE 译码器 buffer 不超过某个上限 (Cat 4 UE: ~2.5M bits)，高 TBS 场景下通过限制 N_cb 来控制缓冲区。

---

## 8. PDSCH 参数配置总表

### 8.1 RRC 配置关键参数

| RRC 参数 | 层级 | 含义 |
|:---------|:----|:-----|
| `resourceAllocation` | `PDSCH-Config` | Type 0 / Type 1 / dynamicSwitch |
| `pdsch-TimeDomainAllocationList` | `PDSCH-Config` | 时域分配表 (最多 16 条目) |
| `dmrs-TypeA-Position` | MIB | pos2 或 pos3 |
| `dmrs-DownlinkForPDSCH-MappingTypeA` | `PDSCH-Config` | Type A DMRS 配置 |
| `dmrs-DownlinkForPDSCH-MappingTypeB` | `PDSCH-Config` | Type B DMRS 配置 |
| `dmrs-AdditionalPosition` | `DMRS-DownlinkConfig` | addPos (0/1/2/3) |
| `vrb-ToPRB-Interleaver` | `PDSCH-Config` | VRB-to-PRB 交织器 bundle 大小 |
| `tci-StatesToAddModList` | `PDSCH-Config` | TCI State 列表 (QCL 配置) |
| `rateMatchPatternToAddModList` | `PDSCH-Config` | 速率匹配 pattern (LTE CRS 等) |
| `mcs-Table` | `PDSCH-Config` | qam64 / qam256 / qam64LowSE |
| `nrofHARQ-ProcessesForPDSCH` | `PDSCH-ServingCellConfig` | DL HARQ 进程数 (2/4/6/8/10/12/16) |

### 8.2 3GPP 规范参考

| 规范 | 章节 | 内容 |
|:-----|:-----|:-----|
| TS 38.211 | §7.3.1 | PDSCH 物理层处理 (加扰/调制/层映射/预编码/RE映射/OFDM) |
| TS 38.211 | §7.4.1.1 | DMRS 序列生成和 RE 映射 |
| TS 38.212 | §5.1-5.4 | CRC/TB分段/LDPC编码/速率匹配 |
| TS 38.212 | §7.3.1 | DCI format 1_0 / 1_1 / 1_2 |
| TS 38.214 | §5.1 | PDSCH 资源分配 (时域/频域) |
| TS 38.214 | §5.1.3 | MCS 和 TBS 确定 |
| TS 38.214 | §5.2 | PDSCH 的 UE 过程 (HARQ-ACK/CSI 等) |
| TS 38.304 | §7.1 | Paging 过程 (PF/PO 计算) |
| TS 38.331 | §6.3.2 | PDSCH-Config / PDSCH-ServingCellConfig IE |

---

*关联文档: [[overview]] | [[nr-frame-structure]] | [[pdcch]] | [[nr-ldpc]] | [[mimo-detection]]*
