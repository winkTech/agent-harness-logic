# 5G NR PDCCH — CORESET / 搜索空间 / DCI

> 最后更新: 2026-06-04
> 关联: [[overview]], [[nr-frame-structure]], [[../ofdm/algorithm_spec]]

---

## 1. PDCCH 概述

### 1.1 功能

PDCCH (Physical Downlink Control Channel) 是 NR 下行物理层控制信令的核心信道，承载 DCI (Downlink Control Information)。其主要功能：

| 功能 | 说明 | 关联信道 / RNTI |
|:-----|:-----|:-----|
| 调度 PDSCH | DL 资源分配、MCS、HARQ 信息 | C-RNTI, CS-RNTI |
| 调度 PUSCH | UL 资源分配、MCS、TPC 命令 | C-RNTI, CS-RNTI |
| TPC (发射功率控制) | 组/单播 PUSCH/PUCCH/SRS 功率命令 | TPC-PUSCH-RNTI, TPC-PUCCH-RNTI, TPC-SRS-RNTI |
| 时隙格式指示 (SFI) | 指示符号为 DL/UL/Flexible | SFI-RNTI |
| 预emption 通知 | 通知 UE 哪些时频资源被抢占 (URLLC) | INT-RNTI |
| 唤醒信号 | 省电，通知 UE 跳过 PDCCH 监听 | PS-RNTI |
| 系统信息调度 | 调度 SIB1、OSI | SI-RNTI |
| 随机接入响应 | Msg2/MsgB 调度 | RA-RNTI, MsgB-RNTI |
| 寻呼 | 寻呼消息调度 | P-RNTI |
| SCell 休眠 | 通知 Scell 进入/退出休眠 | 无 DCI (仅 PDCCH CRC) |

### 1.2 NR vs LTE PDCCH 关键差异

| 特性 | LTE | NR |
|:-----|:----|:---|
| 控制区域 | 固定占用前 1~3 OFDM 符号 (PCFICH 指示) | 灵活 CORESET，可配置频域位置和时域符号数 |
| REG 定义 | 1 REG = 4 RE (频域) | 1 REG = 1 RB × 1 OFDM 符号 (12 RE) |
| REG 捆绑 | 固定 (CCE 内) | 可配置 REG bundle size {2, 3, 6} (interleaved 模式) |
| 参考信号 | CRS (小区级) | DMRS (UE 专用，precoder granularity 可配) |
| 带宽 | 全系统带宽 | BWP 内 (可配置) |
| 波束赋形 | 不支持 | 支持 (DMRS 波束赋形，TCI state 指示 QCL) |

**核心区别**: NR PDCCH 从"全带宽固定位置广播"变为"BWP 内灵活配置波束赋形单播"，大幅提升资源利用率和覆盖。

---

## 2. CORESET (Control Resource Set)

### 2.1 定义

CORESET 是 PDCCH 传输的 **时频资源配置单元**：

```
频域: N_BWP^size 个 RB 中的 N_RB^CORESET 个 RB (bitmap 配置)
时域: N_symb^CORESET ∈ {1, 2, 3} 个 OFDM 符号
```

```
时间 →
频  ┌──────────────────────────────────────────┐
率  │  ┌────────CORESET────────┐               │
↓  │  │ ██████████████████████ │  PDSCH        │
    │  │ █████  PDCCH  ███████ │               │
    │  │ ██████████████████████ │               │
    │  └────────────────────────┘               │
    │  N_symb^CORESET = 2 符号                  │
    └──────────────────────────────────────────┘
```

### 2.2 CCE (Control Channel Element)

CCE 是 PDCCH 的**基本分配单元**：

```
1 CCE = 6 REG (Resource Element Group)
1 REG = 1 RB × 1 OFDM 符号 = 12 RE

1 CCE = 6 RB × 1 OFDM 符号 = 72 RE
      = 其中 DMRS 占 1/4 → 54 RE 用于 DCI 编码比特
```

**聚合级别 (AL)**: PDCCH 由 1/2/4/8/16 个 CCE 组成，对应不同码率和覆盖。

| AL | CCE 数 | RE 数 (DCI) | 典型场景 |
|:--:|:------:|:----------:|:--------|
| 1 | 1 | 54 | 近点 UE, 高 SINR |
| 2 | 2 | 108 | 中近点 UE |
| 4 | 4 | 216 | 中点 UE |
| 8 | 8 | 432 | 远点 UE |
| 16 | 16 | 864 | 小区边缘, 公共信道 |

### 2.3 REG 捆绑 (REG Bundle)

REG bundle 定义为同一个 PRB 内、连续 OFDM 符号上的 REG 集合，UE 假定该 bundle 内使用相同的 precoder，从而可以联合信道估计。

```
Non-interleaved (集中式) 映射:
  CCE 0: REG 0  1  2  3  4  5   → 连续 6 个 RB
          │   │   │   │   │   │
          ▼   ▼   ▼   ▼   ▼   ▼
  RB:     0   1   2   3   4   5

Interleaved (分散式) 映射 (bundle size=2):
  REG bundle: {0,1} {2,3} {4,5} ...
  交织后:     {0,1} → RB 0,1 (bundle 0)
              {2,3} → RB 12,13 (bundle 1) ← 分散到不同位置
              {4,5} → RB 6,7 (bundle 2)
```

REG bundle size 配置：

| REG bundle size | 适用符号数 | 说明 |
|:--------------:|:---------:|:----|
| 2 | 任意 | 默认, 频域 2 RB 捆绑 |
| 3 | 2 或 3 符号 | 频域 3 RB 捆绑 (仅 N_symb=2 或 3) |
| 6 | 2 或 3 符号 | 频域 6 RB 捆绑 (仅 N_symb=2 或 3) |

### 2.4 CORESET 配置参数 (RRC)

```
ControlResourceSet ::= SEQUENCE {
    controlResourceSetId    ControlResourceSetId,      -- 0..11
    frequencyDomainResources BIT STRING (SIZE (45)),  -- 每 bit 对应 6 RB
    duration                INTEGER (1..maxCoReSetDuration),  -- 1/2/3
    cce-REG-MappingType     CHOICE {
        interleaved         SEQUENCE {
            reg-BundleSize  ENUMERATED {n2, n3, n6},
            interleaverSize ENUMERATED {n2, n3, n6},
            shiftIndex      INTEGER(0..maxNrofPhysicalResourceBlocks-1)
        },
        nonInterleaved      NULL
    },
    precoderGranularity     ENUMERATED {sameAsREG-bundle, allContiguousRBs},
    tci-StatesPDCCH         SEQUENCE (SIZE (1..maxNrofTCI-StatesPDCCH))
        OF TCI-StateId
}
```

| 参数 | 取值 | 说明 |
|:-----|:-----|:-----|
| `controlResourceSetId` | 0..11 | CORESET ID, CORESET 0 固定为 0 |
| `frequencyDomainResources` | 45-bit bitmap | 每 bit = 6 RB (1 个 RBG)，对应 BWP 内频域资源 |
| `duration` | 1, 2, 3 | 时域 OFDM 符号数 |
| `cce-REG-MappingType` | interleaved / nonInterleaved | CCE-to-REG 映射方式 |
| `reg-BundleSize` | n2, n3, n6 | REG bundle 大小 (仅 interleaved) |
| `interleaverSize` | n2, n3, n6 | 交织器行数 |
| `shiftIndex` | 0..274 | 交织器偏移 (小区间干扰随机化) |
| `precoderGranularity` | sameAsREG-bundle / allContiguousRBs | DMRS precoder 粒度假定 |
| `tci-StatesPDCCH` | TCI state 列表 | PDCCH DMRS 的 QCL 假设 (波束指示) |

---

## 3. CORESET 0 (初始 CORESET)

### 3.1 概述

CORESET 0 是 UE 初始接入时使用的控制资源集，配置在 MIB 中广播。

- **CORESET ID 固定为 0** (隐式)
- 用于 Type0-PDCCH CSS，调度携带 SIB1 的 PDSCH
- UE 盲检 DCI format 1_0 (SI-RNTI 加扰)

### 3.2 MIB 中的配置

MIB 中 `pdcch-ConfigSIB1` 字段 (8 bit)：

```
pdcch-ConfigSIB1 ::= SEQUENCE {
    controlResourceSetZero   INTEGER (0..15),   -- 高 4 bit
    searchSpaceZero          INTEGER (0..15)    -- 低 4 bit
}
```

`controlResourceSetZero` (4 bit) 查表得到：

| 索引 | SSB/CORESET 复用模式 | N_RB^CORESET | N_symb^CORESET | RB 偏移 |
|:---:|:-------------------:|:------------:|:-------------:|:------:|
| 0 | 1 | 24 | 2 | 0 |
| 1 | 1 | 24 | 2 | 2 |
| 2 | 1 | 24 | 2 | 4 |
| 3 | 1 | 24 | 3 | 0 |
| 4 | 1 | 24 | 3 | 2 |
| 5 | 1 | 24 | 3 | 4 |
| 6 | 1 | 48 | 1 | 12 |
| 7 | 1 | 48 | 1 | 16 |
| 8 | 1 | 48 | 2 | 12 |
| 9 | 1 | 48 | 2 | 16 |
| 10 | 2 | 48 | 1 | 12 |
| 11 | 2 | 48 | 1 | 16 |
| 12 | 2 | 48 | 2 | 12 |
| 13 | 2 | 48 | 2 | 16 |
| 14 | 2 | 96 | 1 | 38 |
| 15 | 3 | 96 | 1 | 38 |

> 注: 上表为 FR1 (sub-6 GHz), SCS=15/30 kHz 时子集示例。完整表见 3GPP TS 38.213 Table 13-1 ~ 13-10，涵盖所有 SCS 组合。

### 3.3 SSB 与 CORESET 0 复用模式

NR 定义了三种 SSB 与 CORESET 0 的复用模式 (Case)，均为 **TDM (时分复用)** — SSB 和 CORESET 0 在相同频域位置，不同符号上传输。

#### Case 1: CORESET 0 与 SSB 频域重叠，时域相邻

用于 SCS 相同的情况 (SSB SCS = PDCCH SCS)。

```
          ┌─────── SSB 周期 (20ms) ───────┐
符号: 0 1 2 3 | 4 5 6 7 8 9 10 11 12 13 | ...
├─────────────┼───────────────────────────┼─────
│    SSB      │         CORESET 0         │
│  (4 符号)    │  (1~3 符号, SCS=SSB SCS) │
└─────────────┴───────────────────────────┘
  频域: SSB 与 CORESET 0 共享相同 RB 范围
```

#### Case 2: CORESET 0 频域包含 SSB，时域分离

CORESET 0 的带宽覆盖 SSB，SSB 和 CORESET 0 在不同符号上。

```
频域 ↑
     │  ┌───────────────────────┐
     │  │      CORESET 0        │  N_RB = 48 或 96
     │  │   ┌─────────────┐     │
     │  │   │    SSB      │     │  SSB (20 RB)
     │  │   │  (4 符号)    │     │
     │  │   └─────────────┘     │
     │  └───────────────────────┘
     └──────────────────────────────→ 时间
     PDCCH SCS ≠ SSB SCS 可行
```

#### Case 3: CORESET 0 与 SSB 频域不重叠

SSB 和 CORESET 0 在不同频域位置（通常不同 BWP 或不同频段段），完全独立。

```
频域 ↑
     │  ┌──────────┐
     │  │ CORESET 0│    N_RB = 96
     │  └──────────┘
     │
     │            ┌──────┐
     │            │ SSB  │    N_RB = 20
     │            └──────┘
     └──────────────────────────────→ 时间
```

### 3.4 Type0-PDCCH CSS 监视时机

SSB 索引 i 与监视时机的映射由以下参数确定：

- **O**: 相对于 SSB 起始时隙的偏移 (时隙数)
- **M**: 两个连续 SSB 索引对应的监视时机之间的时隙间隔
- **起始符号索引**: 由 `searchSpaceZero` 查表确定

```
时隙:    n       n+1     n+2     n+3      ...
       ┌──────┐┌──────┐┌──────┐┌──────┐
SSB 0: │CORESET││      ││      ││      │
       │  0   ││      ││      ││      │
       └──────┘└──────┘└──────┘└──────┘
              O     M
                     ┌──────┐
SSB 1:              │CORESET│
                     │  0   │
                     └──────┘
```

---

## 4. 搜索空间 (Search Space)

### 4.1 搜索空间类型

| 类型 | 名称 | 用途 | RNTI 示例 |
|:----|:-----|:-----|:----------|
| Type0 | Common (CSS) | SIB1 调度 | SI-RNTI |
| Type0A | Common (CSS) | OSI 调度 | SI-RNTI |
| Type1 | Common (CSS) | RAR (随机接入响应) | RA-RNTI, MsgB-RNTI, TC-RNTI |
| Type2 | Common (CSS) | 寻呼 | P-RNTI |
| Type3 | Common (CSS) | 组公共 DCI | INT-RNTI, SFI-RNTI, TPC-*, PS-RNTI |
| USS | UE-Specific | UE 专用数据调度 | C-RNTI, CS-RNTI, MCS-C-RNTI, SP-CSI-RNTI |

### 4.2 搜索空间配置参数 (RRC)

```
SearchSpace ::= SEQUENCE {
    searchSpaceId                       SearchSpaceId,   -- 0..39
    controlResourceSetId                ControlResourceSetId,
    monitoringSlotPeriodicityAndOffset  CHOICE {
        sl1     NULL, sl2     INTEGER(0..1), sl4     INTEGER(0..3),
        sl5     INTEGER(0..4), sl8     INTEGER(0..7), sl10    INTEGER(0..9),
        sl16    INTEGER(0..15), sl20    INTEGER(0..19), sl40   INTEGER(0..39),
        sl80    INTEGER(0..79), sl160   INTEGER(0..159),
        sl320   INTEGER(0..319), sl640  INTEGER(0..639),
        sl1280  INTEGER(0..1279), sl2560 INTEGER(0..2559)
    },
    duration                            INTEGER (2..2559),
    monitoringSymbolsWithinSlot         BIT STRING (SIZE (14)),
    nrofCandidates                      SEQUENCE {
        aggregationLevel1   ENUMERATED {n0,n1,n2,n3,n4,n5,n6,n8},
        aggregationLevel2   ENUMERATED {n0,n1,n2,n3,n4,n5,n6,n8},
        aggregationLevel4   ENUMERATED {n0,n1,n2,n3,n4,n5,n6,n8},
        aggregationLevel8   ENUMERATED {n0,n1,n2,n3,n4,n5,n6,n8},
        aggregationLevel16  ENUMERATED {n0,n1,n2,n3,n4,n5,n6,n8}
    },
    searchSpaceType                     CHOICE {
        common      SEQUENCE { ... },
        ue-Specific SEQUENCE {
            dci-Formats ENUMERATED {formats0-0-And-1-0, formats0-1-And-1-1}
        }
    }
}
```

| 参数 | 取值 | 说明 |
|:-----|:-----|:-----|
| `searchSpaceId` | 0..39 | 搜索空间 ID |
| `controlResourceSetId` | 0..11 | 关联的 CORESET |
| `monitoringSlotPeriodicityAndOffset` | sl1..sl2560 | 监视周期 (时隙) 和偏移 |
| `duration` | 2..2559 | 连续监视的时隙数 |
| `monitoringSymbolsWithinSlot` | 14-bit bitmap | 时隙内监视的起始符号 (按 CORESET duration 扩展) |
| `nrofCandidates` | n0..n8 per AL | 每个聚合级别的 PDCCH candidate 数量 |

### 4.3 监视时机确定

**时隙级监视时机**:

```
Frame SFN 被监视的时隙满足:
  (SFN × N_slot^frame + n_slot - offset) mod periodicity = 0

其中 N_slot^frame = 每无线帧时隙数 (= 10 × 2^μ)
```

```
示例: periodicity=sl4, offset=1, μ=1 (30kHz, 20 slots/frame)
  被监视时隙: #1, #5, #9, #13, #17, ...
```

**符号级监视时机**:

`monitoringSymbolsWithinSlot` 的 14-bit bitmap 指示时隙内哪些起始符号是监视时机的起点。

```
monitoringSymbolsWithinSlot: 00000011000000
                              01234567890123
                                ↑↑
                             符号 6, 7 为监视起始点

14 符号时隙:
┌─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┐
│ │ │ │ │ │ │M│M│ │ │ │ │ │ │
└─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┘
           ↑ ↑
   CORESET duration=2:
   符号 6,7 和 7,8 为两个监视时机
```

### 4.4 聚合级别与 PDCCH Candidate

**USS PDCCH candidate 数量示例** (nrofCandidates):

| AL | CCE 占用 | Candidate 数 (典型) | 盲检次数 |
|:--:|:--------:|:-------------------:|:-------:|
| 1 | 1 CCE | 0~8 | 每次 candidate 1 次盲检 |
| 2 | 2 CCE | 0~8 | 每次 candidate 1 次盲检 |
| 4 | 4 CCE | 0~8 | 每次 candidate 1 次盲检 |
| 8 | 8 CCE | 0~8 | 每次 candidate 1 次盲检 |
| 16 | 16 CCE | 0~8 | 每次 candidate 1 次盲检 |

**CSS 使用固定的 candidate 数量**，不通过 RRC 配置，而是由 TS 38.213 Table 10.1-1 确定。

---

## 5. DCI 格式

### 5.1 格式分类

```
                  UL Grant                DL Grant               Group Common
                  ────────               ────────               ────────────
NR DCI:
    ├── 0_0 (UL fallback)          ├── 1_0 (DL fallback)      ├── 2_0 (SFI)
    ├── 0_1 (UL non-fallback)      ├── 1_1 (DL non-fallback)  ├── 2_1 (Preemption)
    └── 0_2 (UL compact)           └── 1_2 (DL compact)       ├── 2_2 (TPC PUSCH/PUCCH)
                                                                ├── 2_3 (TPC SRS)
                                                                ├── 2_4 (UL cancel)
                                                                └── 2_6 (Wake-up / SCell dormancy)
```

### 5.2 各格式字段对比

#### DL Grant

| 字段 | 1_0 (fallback) | 1_1 (non-fallback) | 1_2 (compact) |
|:-----|:-------------:|:------------------:|:-------------:|
| DCI format identifier | 1 bit | 1 bit | 1 bit |
| Frequency domain resource assignment | 可变 (RAType0/1) | 可变 | 可变 (紧凑) |
| Time domain resource assignment | 4 bit | 0~4 bit | 0~4 bit |
| VRB-to-PRB mapping | 1 bit (仅 RAType1) | 0~1 bit | 0~1 bit |
| PRB bundling size indicator | -- | 0~1 bit | -- |
| Rate matching indicator | -- | 0~2 bit | -- |
| ZP CSI-RS trigger | -- | 0~2 bit | -- |
| Modulation and coding scheme (MCS) | 5 bit | 5 bit | 5 bit |
| New data indicator (NDI) | 1 bit | 1 bit | 1 bit |
| Redundancy version (RV) | 2 bit | 2 bit | 2 bit |
| HARQ process number | 4 bit | 4 bit | 4 bit |
| Downlink assignment index (DAI) | 2 bit (仅 CA) | 0/2/4 bit | 0/2 bit |
| TPC command for PUCCH | 2 bit | 2 bit | 2 bit |
| PUCCH resource indicator | 3 bit | 0~3 bit | 0~3 bit |
| PDSCH-to-HARQ_feedback timing | 3 bit | 0~3 bit | 0~3 bit |
| Antenna port(s) | -- | 4~6 bit | 4~5 bit |
| TCI (Transmission Configuration Indication) | -- | 0~3 bit | -- |
| SRS request | -- | 0~3 bit | -- |
| DMRS sequence initialization | -- | 0~1 bit | 0~1 bit |
| CBG transmission info | -- | 0~8 bit | -- |
| Priority indicator | -- | 0~1 bit | 0~1 bit |

#### UL Grant

| 字段 | 0_0 (fallback) | 0_1 (non-fallback) | 0_2 (compact) |
|:-----|:-------------:|:------------------:|:-------------:|
| DCI format identifier | 1 bit | 1 bit | 1 bit |
| Frequency domain resource assignment | 可变 | 可变 | 可变 (紧凑) |
| Time domain resource assignment | 4 bit | 0~4 bit | 0~4 bit |
| Frequency hopping flag | 1 bit | 0~1 bit | 0~1 bit |
| Modulation and coding scheme (MCS) | 5 bit | 5 bit | 5 bit |
| New data indicator (NDI) | 1 bit | 1 bit | 1 bit |
| Redundancy version (RV) | 2 bit | 2 bit | 2 bit |
| HARQ process number | 4 bit | 4 bit | 4 bit |
| TPC command for PUSCH | 2 bit | 2 bit | 2 bit |
| UL/SUL indicator | 0~1 bit | 0~1 bit | -- |
| DMRS sequence initialization | -- | 0~1 bit | 0~1 bit |
| Antenna port(s) | -- | 2~5 bit | 2~5 bit |
| SRS resource indicator | -- | 0~4 bit | 0~4 bit |
| Precoding info and layers | -- | 0~6 bit | 0~4 bit |
| CSI request | -- | 0~6 bit | -- |
| CBG transmission info | -- | 0~8 bit | -- |
| PTRS-DMRS association | -- | 0~2 bit | 0~2 bit |
| beta_offset indicator | -- | 0~2 bit | -- |
| Priority indicator | -- | 0~1 bit | 0~1 bit |
| Open-loop power control set | -- | 0~2 bit | 0~1 bit |

#### Group Common (DCI format 2_x)

| 格式 | 名称 | RNTI | 内容 |
|:----|:-----|:-----|:-----|
| 2_0 | SFI | SFI-RNTI | 每服务小区 slot format combination (时隙格式组合) |
| 2_1 | Preemption | INT-RNTI | 14-bit bitmap 每服务小区 (OFDM 符号/PRB 组抢占指示) |
| 2_2 | TPC | TPC-PUSCH/PUCCH-RNTI | 每 UE 的 TPC 命令 (2 bit) |
| 2_3 | TPC SRS | TPC-SRS-RNTI | 每 SRS 资源集合的 TPC 命令 |
| 2_4 | UL Cancel | CI-RNTI | 指示 UE 取消 UL 传输的资源 |
| 2_6 | Power Saving | PS-RNTI | Wake-up 指示 / SCell dormancy |

### 5.3 DCI Size 对齐

为避免 UE 盲检时 DCI 格式歧义，3GPP 规定 DCI size budget 和 size 对齐规则：

**Size Budget**: UE 最多处理 3 种不同的 DCI payload size (每个小区)，加上 C-RNTI 加扰的额外 1 种（合计最多 4 种）。

**对齐方法**:
1. **Zero-padding**: 将较短 DCI 格式补 0 直到与较长格式相同长度
2. **截断频域分配**: 优先截断 `frequencyDomainResources` 中 MSB 的 0
3. **Size matching priorities**:
   - 1_0 与 0_0 对齐 (同一搜索空间)
   - 1_2 与 0_2 对齐 (同一搜索空间)
   - 1_1 与 0_1 独立但计入 budget

```
示例: DCI 1_0 (fallback, 36 bit) 与 DCI 0_0 (fallback, 34 bit)
  → 0_0 补 2 bit zero-padding → 均为 36 bit
  → UE 通过 "DCI format identifier" 字段 (1 bit) 区分
```

---

## 6. PDCCH 盲检流程

### 6.1 盲检总流程

```
每时隙、每服务小区 (active DL BWP):

对每个搜索空间 s (CSS set / USS set):
    对每个聚合级别 AL ∈ {1,2,4,8,16}:
        确定该 AL 的 CCE candidate 起始位置
        对每个 candidate (共 nrofCandidates 个):
            对每个待盲检 DCI format:
                提取 CCE 中的 RE (解资源映射)
                │
                ▼
                信道估计 (DMRS)
                │
                ▼
                均衡 + 解调 (QPSK)
                │
                ▼
                速率解匹配 → Polar 译码
                │
                ▼
                CRC 校验 (用对应 RNTI)
                │
                ├─ CRC 通过 → DCI 成功解码 ✓
                └─ CRC 失败 → 尝试下一个 candidate
```

### 6.2 CCE Candidate 位置计算 (USS)

对于 USS，CCE candidate 位置由哈希函数确定 (TS 38.213 §10.1)：

```
L × { (Y_{p,nCI} + ⌊ m_s,nCI × N_CCE,p / (L × M_s,max^L) ⌋ + n_CI ) mod ⌊ N_CCE,p / L ⌋ } + i

其中:
  L                = 聚合级别
  i = 0,...,L-1    = candidate 内 CCE 索引
  m_s,nCI          = candidate 索引 (0..M_s^L - 1)
  M_s^L            = 该 AL 的 candidate 数量
  N_CCE,p          = CORESET p 中的 CCE 总数
  n_CI = 0         = 非 CA 场景
  Y_{p,nCI}        = 哈希函数值
```

**Y_p 哈希函数**:

```
Y_p = (A_p × Y_{p-1}) mod D

初始化: Y_{-1} = n_RNTI ≠ 0
A_0 = 39827   (p mod 3 = 0)
A_1 = 39829   (p mod 3 = 1)
A_2 = 39839   (p mod 3 = 2)
D   = 65537
```

每次监视时机都会更新 Y_p，使不同时隙的 candidates 落在不同 CCE 上，实现干扰随机化。

### 6.3 RNTI 与 CRC 加扰

PDCCH 的 24-bit CRC 被 16-bit RNTI 加扰：

```
CRC 加扰:
  c_k = (b_k + x_{rnti,k-16}) mod 2   对于 k = 16..23

其中 b_k 为原始 CRC 比特，x_{rnti,k-16} 为 RNTI 的第 (k-16) bit
(仅加扰 CRC 的高 16 bit，低 8 bit 不加扰)
```

| RNTI | 值范围 | 用途 | 搜索空间 |
|:-----|:------|:-----|:---------|
| C-RNTI | – | 单播数据调度 (RRC_CONNECTED) | USS |
| CS-RNTI | – | 配置调度 (SPS/CG) | USS |
| MCS-C-RNTI | – | 低码率 MCS 表指示 (URLLC 备选) | USS |
| TC-RNTI | – | Msg3 重传 (RACH 期间临时) | Type1 CSS |
| SI-RNTI | FFFF | 系统信息调度 (SIB1/OSI) | Type0/0A CSS |
| P-RNTI | FFFE | 寻呼 | Type2 CSS |
| RA-RNTI | 0001~FFEF | 随机接入响应 (Msg2) | Type1 CSS |
| MsgB-RNTI | 0001~FFEF | 2-step RACH MsgB | Type1 CSS |
| TMP-C-RNTI | – | 竞争解决前临时 C-RNTI | Type1 CSS |
| SFI-RNTI | – | 时隙格式指示 (DCI 2_0) | Type3 CSS |
| INT-RNTI | – | 抢占指示 (DCI 2_1) | Type3 CSS |
| TPC-PUSCH-RNTI | – | PUSCH 组功率控制 (DCI 2_2) | Type3 CSS |
| TPC-PUCCH-RNTI | – | PUCCH 组功率控制 (DCI 2_2) | Type3 CSS |
| TPC-SRS-RNTI | – | SRS 组功率控制 (DCI 2_3) | Type3 CSS |
| CI-RNTI | – | UL 取消指示 (DCI 2_4) | Type3 CSS |
| PS-RNTI | – | 省电 (DCI 2_6) | Type3 CSS |
| SP-CSI-RNTI | – | 半持续 CSI 激活/去激活 | USS |

### 6.4 盲检复杂度限制

NR 对 UE 盲检次数设定硬性上限以控制复杂度：

| 场景 | 限制 | 说明 |
|:-----|:---:|:-----|
| 每时隙总 PDCCH candidates (FR1, 单小区) | ≤ 44 | CSS + USS 合并计数 |
| 每时隙总 PDCCH candidates (FR2) | ≤ 36 | 毫米波场景 |
| 每时隙总不重叠 CCE 数 (FR1) | ≤ 56 | 对齐 CCE budget |
| 每时隙总不重叠 CCE 数 (FR2) | ≤ 48 | 对齐 CCE budget |
| CSS 最大 candidate 数 | ≤ 7~15 (视配置) | TS 38.213 Ch.10.1 |
| USS 最大 candidate 数 | ≤ 总预算 - CSS 消耗 | 剩余部分 |

**Candidate 计数规则**:
- 相同的 CCE 集合算作"重叠" (overlapped)
- CSS 和 USS 的 overlapping CCE 只计 1 次 (counting rule)
- 若 total CCE 超限: 从 USS 优先级最低的搜索空间开始丢弃

### 6.5 PDCCH DMRS

PDCCH DMRS 用于相干解调，映射方式:

```
1 REG = 1 RB × 1 OFDM 符号 = 12 RE:
  ┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
  │DM │ D │ D │DM │ D │ D │DM │ D │ D │DM │ D │ D │
  │RS │   │   │RS │   │   │RS │   │   │RS │   │   │
  └───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
   k=0   1   2   3   4   5   6   7   8   9  10  11

  DMRS 位置: subcarrier 0, 3, 6, 9 (3 子载波间隔)
  DMRS 密度: 1/4 of RE
```

**DMRS 序列生成** (Gold sequence):

```
r(m) = 1/√2 × (1 - 2×c(2m)) + j × 1/√2 × (1 - 2×c(2m+1))

初始化 (每 OFDM 符号):
  c_init = (2^17 × (N_symb^slot × n_s,f^μ + l + 1) × (2N_ID + 1) + 2N_ID) mod 2^31

其中:
  N_ID ∈ {0, 1, ..., 65535}  (pdcch-DMRS-ScramblingID, 未配置则用 PCI)
  N_symb^slot = 14
  n_s,f^μ = frame 内时隙号
  l = OFDM 符号号
```

---

## 7. 参考规范

| 规范 | 章节 | 内容 |
|:-----|:-----|:-----|
| TS 38.211 | §7.3.2 | PDCCH 物理资源映射、REG/CCE 定义 |
| TS 38.211 | §7.4.1.3 | PDCCH DMRS 序列生成 |
| TS 38.212 | §7.3 | DCI 格式和 payload 编码 |
| TS 38.212 | §7.3.3~7.3.4 | DCI size 对齐 |
| TS 38.213 | §10 | UE PDCCH 接收过程 |
| TS 38.213 | §10.1 | CCE candidate 位置确定 (哈希函数) |
| TS 38.213 | §13 | CORESET 0 和 Type0-PDCCH CSS |
| TS 38.214 | §5.1 | PDSCH 调度 (DCI 1_x 解释) |
| TS 38.331 | §6.3.2 | CORESET / SearchSpace RRC IE |
