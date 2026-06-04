# 5G NR PUSCH & PUCCH -- 物理上行信道深度解析

> 最后更新: 2026-06-04
> 关联: [[overview]], [[nr-frame-structure]], [[nr-prach]], [[pdcch]], [[pdsch]], [[nr-ldpc]]
> 对齐: 3GPP TS 38.211 §6.2-6.4, TS 38.212 §5-7, TS 38.213 §7-9

---

## 1. PUSCH 概述

### 1.1 PUSCH 功能定位

PUSCH (Physical Uplink Shared Channel) 是 NR 上行物理层核心数据信道。其主要承载：

| 载荷类型 | 内容 | 触发条件 |
|:--------|:-----|:--------|
| **UL-SCH** | 用户面上行数据 (DTCH/DCCH/CCCH) | gNB 调度或 CG 自主发送 |
| **UCI on PUSCH** | HARQ-ACK / CSI Part1+Part2 / SR | 与 PUSCH 时隙冲突时复用 |
| **Msg3 PUSCH** | RRC Connection Request (4-step RACH) | RAR 中的 UL Grant |
| **MsgA PUSCH** | RRC Connection Request (2-step RACH) | 与 PRACH 前导联合发送 |

PUSCH **不承载**的内容：纯 UCI (无数据时使用 PUCCH)、广播/系统信息 (仅下行有)。

### 1.2 调度方式

NR PUSCH 支持三种调度方式，覆盖不同时延和信令开销需求：

```
调度方式对比:

动态调度 (DG)                  配置授权 (CG Type 1)              配置授权 (CG Type 2)
┌──────────────────┐           ┌──────────────────┐           ┌──────────────────┐
│ gNB 发送 DCI     │           │ RRC 一次性配置    │           │ RRC 配置 +        │
│ (每 TTI 一次)    │           │ 全部参数          │           │ DCI 激活/释放     │
│        │         │           │        │          │           │        │          │
│        ▼         │           │        ▼          │           │        ▼          │
│ UE 在 K2 时隙    │           │ UE 按配置周期     │           │ UE 收到激活 DCI   │
│ 发送 PUSCH       │           │ 自主发送 PUSCH    │           │ 后按周期发送      │
└──────────────────┘           └──────────────────┘           └──────────────────┘
  信令开销: 每 TTI              信令开销: 仅 RRC              信令开销: RRC + 一次 DCI
  灵活性: 最高                  灵活性: 最低                  灵活性: 中等
  时延: 较高 (K2 等待)          时延: 最低 (零等待)           时延: 极低 (激活后零等待)
  适用: eMBB                    适用: 周期性固定大小业务       适用: URLLC / VoIP / V2X
```

| 调度方式 | DCI 格式 | 参数来源 | 激活/释放机制 | 典型场景 |
|:--------|:--------|:--------|:------------|:--------|
| **动态调度** | DCI 0_0 / 0_1 / 0_2 | 全部由 DCI 指示 | 无需激活 (每 TTI 调度) | eMBB 大包业务 |
| **CG Type 1** | 无 DCI (纯 RRC) | `ConfiguredGrantConfig` (RRC) | RRC 配置即生效 | 周期性小包 (VoIP) |
| **CG Type 2** | DCI 0_0/0_1/0_2 (CS-RNTI) | RRC 基础 + DCI 激活补充 | DCI 激活 / DCI 释放 | URLLC / V2X 低时延 |

### 1.3 波形选择: CP-OFDM vs DFT-s-OFDM

NR 上行支持两种波形，通过高层参数 `transformPrecoder` 控制：

```
transformPrecoder = disabled → CP-OFDM (变换预编码关闭)
transformPrecoder = enabled  → DFT-s-OFDM (变换预编码开启, 即 SC-FDMA)
```

| 特性 | CP-OFDM | DFT-s-OFDM (变换预编码) |
|:----|:--------|:-----------------------|
| **PAPR** | 高 (~10-12 dB) | 低 (~5-7 dB) |
| **功率效率** | 低 (需 PA 回退) | 高 (PA 可接近饱和区) |
| **MIMO 层数** | 最多 4 层 (FR1) / 8 层 | **仅单层 (rank-1)** |
| **调制阶数** | 最高 256QAM (Rel-15) / 1024QAM (Rel-17) | 最高 256QAM (Rel-17 前) / 1024QAM |
| **频域调度粒度** | 1 个子载波 (精细) | **连续 RB 分配** (粗粒度) |
| **适用场景** | 小区中心、高 SINR、多层 MIMO | 小区边缘、功率受限、覆盖增强 |
| **强制支持** | gNB 和 UE 必须支持 | UE 可选 (能力信令) |
| **默认波形** | RRC_CONNECTED 态默认 | Msg3 PUSCH 强制使用 |

**Msg3 PUSCH 强制 DFT-s-OFDM**：初始接入阶段 UE 功率控制未收敛，低 PAPR 可保证覆盖。RRC 建立后可重配置为 CP-OFDM。

### 1.4 K2 时序 (PDCCH -> PUSCH)

K2 表示承载 UL Grant 的 PDCCH 所在时隙与对应 PUSCH 发送时隙之间的偏移量（单位: 时隙）。

```
PDCCH (UL Grant)                         PUSCH 发送
时隙 n                                    时隙 n + K2
    │                                        │
    ├──── K2 个时隙 ────────────────────────→│
    │                                        │
    ▼                                        ▼
┌────────┐                              ┌────────┐
│ DCI    │                              │ PUSCH  │
│ 0_1    │                              │ TB     │
└────────┘                              └────────┘
```

| 参数 | 取值范围 | 配置方式 | 说明 |
|:----|:--------|:--------|:-----|
| K2 (时隙) | 0 ~ 32 | RRC `PUSCH-TimeDomainResourceAllocation` 列表 | DCI 中的 Time domain RA 字段索引列表条目 |
| 默认 K2 表 (DCI 0_0) | {1,2,3,4,5,6,7,8} (μ=0/1) | TS 38.214 Table 6.1.2.1.1-2/4 | 回退 DCI 使用预定义表，j=1/2/3 对应不同 PUSCH mapping type |

**K2=0 的含义**: PDCCH 与 PUSCH 在同一时隙发送 (仅当 PDCCH 在时隙前部时可行)。

**j 参数 (DCI 0_0 默认表)**: j 由 `PUSCH-TimeDomainResourceAllocationListForDCIformat0_0` 或 SSB 索引隐式确定，影响默认时域分配表中的行选择。

---

## 2. PUSCH 资源分配

### 2.1 频域资源分配

PUSCH 频域资源分配复用 PDSCH 的设计框架，支持 Type 0 和 Type 1 两种方案：

| RA 类型 | 指示方式 | 粒度 | 适用场景 | DCI 格式 |
|:-------|:--------|:----|:--------|:--------|
| **Type 0** | 位图 (bitmap) | RBG (Resource Block Group) | 非连续分配、高吞吐 | DCI 0_1 / 0_2 |
| **Type 1** | RIV (Resource Indication Value) | 1 RB | 连续分配、DFT-s-OFDM | DCI 0_0 / 0_1 / 0_2 |
| **dynamicSwitch** | DCI 1 bit 选择 Type 0 或 Type 1 | 按选择 | 灵活调度 | DCI 0_1 / 0_2 |

#### Type 0 (RBG 位图)

```
BWP RB: 0  1  2  3  4  5  6  7  8  9 10 11 ... (共 N_BWP 个 RB)
         │ RBG 0 │ RBG 1 │ RBG 2 │ RBG 3 │ ...   (每个 RBG 包含 P 个 RB)

bitmap:   1        0        1        1      ...
         分配      不分配    分配      分配
```

- RBG 大小 P 由 BWP 大小和配置类型 (Configuration 1 / Configuration 2) 决定 (TS 38.214 Table 6.1.2.2.1-1)
- 位图长度 = ceil(N_BWP / P) 比特
- 优点：非连续分配，多用户频分复用灵活

#### Type 1 (RIV 连续分配)

```
单一连续 RB 块, 由起始 RB (RB_start) 和长度 (L_RBs) 编码为 RIV:

RIV = N_BWP × (L_RBs - 1) + RB_start    (当 L_RBs - 1 ≤ floor(N_BWP/2))
RIV = N_BWP × (N_BWP - L_RBs + 1) + (N_BWP - 1 - RB_start)  (否则)
```

- DCI 0_0 始终使用 Type 1 (与 PUSCH 的 DFT-s-OFDM 单载波特性匹配)
- 频域跳频时，DCI 0_1 也使用 Type 1

### 2.2 时域资源分配

PUSCH 时域分配通过 SLIV (Start and Length Indicator Value) 编码起始符号 S 和长度 L：

```
一个时隙内 (14 OFDM 符号):

        S = 起始符号 (0~13)
        L = 持续符号数 (1~14, S+L ≤ 14)

SLIV 编码:
        if    L-1 ≤ 7:  SLIV = 14×(L-1) + S
        else            SLIV = 14×(14-L+1) + (14-1-S)
```

**PUSCH Mapping Type**:

| Mapping Type | 有效 S | 有效 L | 特点 |
|:------------|:------|:------|:-----|
| **Type A** | S = 0 | L ∈ {4,...,14} (Normal CP) / {4,...,12} (Extended CP) | 时隙起始, 适合时隙级调度 |
| **Type B** | S ∈ {0,...,13} | L ∈ {1,...,14} (多种组合) | 灵活起始位置, 适合 mini-slot / URLLC |

```
Type A:                            Type B:
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ PUSCH (S=0, L=12)            │   │     PUSCH (S=3, L=4)         │
│████████████████░░░░░░░░░░░░░░│   │░░░████████████░░░░░░░░░░░░░░░│
│ 0                      13    │   │ 0                      13    │
└──────────────────────────────┘   └──────────────────────────────┘
```

### 2.3 跳频 (Frequency Hopping)

跳频提供频率分集增益，提升上行覆盖和可靠性。

| 跳频类型 | 模式 | 机制 | RRC 参数 |
|:--------|:----|:-----|:--------|
| **Intra-slot** | 时隙内两跳 | 前半符号在第一跳 RB，后半符号在第二跳 RB | `frequencyHopping = 'intraSlot'` |
| **Inter-slot** | 时隙间跳频 | 偶数时隙在第一跳 RB，奇数时隙在第二跳 RB | `frequencyHopping = 'interSlot'` |

```
Intra-slot 跳频 (时隙内):

┌──────────────────────────────────────┐
│ Hop 1 (前半符号) │ Hop 2 (后半符号)   │
│   RB_offset_1    │   RB_offset_2      │
│   ████████████   │   ████████████     │
│                  │                    │
│ <-- 符号 0~6 --> │ <-- 符号 7~13 -->  │
└──────────────────────────────────────┘

Inter-slot 跳频 (时隙间):

时隙 n:     ████████████ (RB_offset_1)
时隙 n+1:   ████████████ (RB_offset_2)
时隙 n+2:   ████████████ (RB_offset_1)
```

**第二跳 RB 偏移计算**:

```
RB_offset_2 = RB_offset_1 + RB_offset

其中 RB_offset 由 RRC 配置为以下之一:
- 固定值 (RB_offset ∈ {0,...,274})
- 通过公式 floor(N_BWP/2) 或 floor(N_BWP/4) 隐式确定
```

### 2.4 变换预编码 (DFT-s-OFDM)

| 参数 | 说明 |
|:----|:-----|
| `transformPrecoder` | RRC 参数, 使能/禁用 DFT 扩频 |
| 适用层数 | **仅 rank-1 (单层传输)** |
| 调制约束 | 原则上支持 pi/2-BPSK 可选, QPSK ~ 256QAM |
| 资源分配约束 | 分配的 RB 数必须满足 $M_{RB}^{PUSCH} = 2^{\alpha_2} \times 3^{\alpha_3} \times 5^{\alpha_5}$ (含因子 2/3/5), 保证 DFT 可高效实现 |
| FDSS (频域频谱成型) | 可选 Pi/2-BPSK + FDSS, 进一步降低 PAPR |

```
DFT-s-OFDM 核心思想:

调制符号 → M-point DFT → 子载波映射 → N-point IFFT → +CP
 (时域)      (频域扩频)   (集中式映射)  (OFDM调制)

vs CP-OFDM:
调制符号 → 子载波映射 → N-point IFFT → +CP
 (频域)     (任意映射)
```

### 2.5 CP-OFDM vs DFT-s-OFDM 完整对比

| 维度 | CP-OFDM | DFT-s-OFDM (变换预编码) |
|:----|:--------|:-----------------------|
| **PAPR (dB)** | 10~12 | 5~7 (降低约 3~5 dB) |
| **PA 效率** | 低 (需 6~10 dB 回退) | 高 (可接近 P1dB) |
| **最大层数** | 4 (FR1) / 8 (FR2) | 1 (仅单层) |
| **最大调制** | 256QAM (Rel-15) / 1024QAM (Rel-17) | 256QAM (Rel-15) / 1024QAM (Rel-17) |
| **RB 分配** | 任意 (Type 0 + Type 1) | 连续 RB + 数量约束 (2^α₂×3^α₃×5^α₅) |
| **DMRS** | Gold 序列 (同 PDSCH) | 低 PAPR 序列 (Zadoff-Chu 基) |
| **相位噪声敏感度** | 中 | 低 (DFT 扩频提供额外鲁棒性) |
| **频域均衡** | 单抽头 MMSE | 单抽头 MMSE (有 ISI 残余) |
| **适用覆盖** | 中/近点 | 远点 / 小区边缘 |
| **UE 能力** | 必选 | 可选 (Msg3 强制) |
| **FDSS 支持** | 否 | 是 (pi/2-BPSK + 频谱成型) |

---

## 3. PUSCH DMRS

### 3.1 DMRS 配置概述

PUSCH DMRS 用于上行信道估计和相干解调，其配置与 PDSCH DMRS 对称对齐。

| 参数 | 可选值 | 说明 |
|:----|:------|:-----|
| **DMRS Type** | Type 1 / Type 2 | 频域复用密度 (同 PDSCH) |
| **Max Length** | 1 (单符号) / 2 (双符号) | 时域符号数 |
| **Additional Position** | pos0 / pos1 / pos2 / pos3 | 额外 DMRS 位置 (高速场景) |
| **前置 DMRS 位置** | 取决于 PUSCH mapping type | Type A: l₀=2 或 3; Type B: l₀=0 (PUSCH 起始符号) |

### 3.2 DMRS Type 1 vs Type 2

```
DMRS Configuration Type 1 (1-symbol):     DMRS Configuration Type 2 (1-symbol):
频域 (1 RB = 12 RE)                       频域 (1 RB = 12 RE)
┌────────────────────┐                    ┌────────────────────────────┐
│ RE  │0  1  2 ... 11│                    │ RE  │0 1│2 3│4 5│6 7│8 9│10 11│
├────────────────────┤                    ├────────────────────────────┤
│Port│ 1000/1001     │                    │Port│1000│1001│1002│1003│1004│1005│
│CDM │ 2 (频域OCC)   │                    │CDM │ 2  │ 2  │ 2  │ 2  │ 2  │ 2  │
│密度│ 每2 RE 1 DMRS  │                    │密度│ 每2 RE 1 DMRS (每对)     │
│端口│ 最多 4 (双符号) │                    │端口│ 最多 12 (双符号)         │
└────────────────────┘                    └────────────────────────────┘
```

| 特性 | DMRS Type 1 | DMRS Type 2 |
|:----|:-----------|:-----------|
| 频域密度 | 50% (每个端口每 2 个 RE 一个 DMRS) | 33% (每对连续 2 RE 一个 DMRS) |
| 单符号最大端口数 | 4 | 6 |
| 双符号最大端口数 | 8 | 12 |
| CDM 组数 | 2 | 3 |
| 适用场景 | 低/中 rank (≤4) | 高 rank / MU-MIMO (≤12) |
| OFDM 符号开销 | 低 (1/14 ≈ 7%) | 低 (1/14 ≈ 7%) |

### 3.3 单符号 vs 双符号 DMRS

```
单符号 DMRS (maxLength = 1):              双符号 DMRS (maxLength = 2):
┌──────────────────────────────┐           ┌──────────────────────────────┐
│  D  D  D  M  D  D  D  ...    │           │  D  D  D  M  M  D  D  ...    │
│                      ↑       │           │           ↑──↑──↑             │
│                    前置DMRS  │           │          时域OCC              │
└──────────────────────────────┘           │     (port 加倍, 正交性增强)    │
                                           └──────────────────────────────┘

单符号: 每个 DMRS 端口占用 1 个 OFDM 符号，频域 OCC 仅
双符号: 每个 DMRS 端口占用 2 个连续 OFDM 符号, 时域 OCC [+1,+1] / [+1,-1] 实现额外正交
```

| 配置 | 单符号端口数 (Type1/Type2) | 双符号端口数 (Type1/Type2) | 适用场景 |
|:----|:------------------------:|:------------------------:|:--------|
| 1-symbol | 4 / 6 | 8 / 12 | 低多普勒 (静止/步行) |
| 2-symbol | N/A | 8 / 12 | 高多普勒 (高速移动), MU-MIMO 多端口 |

### 3.4 变换预编码开启时的 DMRS

当 `transformPrecoding = enabled` (DFT-s-OFDM)，DMRS 序列使用 **低 PAPR 序列** 替代 Gold 序列：

```
前置 DMRS 位置: 在时隙内占用固定符号位置
  - PUSCH mapping type A: 符号 l₀ (通常 l₀=2 或 3)
  - PUSCH mapping type B: 符号 0 (PUSCH 首个符号)

低 PAPR 序列:
  - 基序列: Zadoff-Chu (ZC) 序列 或 计算机生成序列 (CGS)
  - 序列长度: M_ZC = m × N_sc^RB / 2^δ  (即 RB 子载波数的一半, 频域梳状映射)
  - 组跳变 (group hopping) 和 序列跳变 (sequence hopping) 可选
```

**DMRS 序列生成 (DFT-s-OFDM 模式)**:

$$
r_{u,v}^{(\alpha,\delta)}(n) = e^{j\alpha n} \cdot \bar{r}_{u,v}(n), \quad 0 \leq n < M_{ZC}
$$

其中 $\bar{r}_{u,v}(n)$ 为基序列，u=组号，v=序列号，$\alpha$=循环移位。

### 3.5 DMRS 与 UCI 复用

当 UCI 在 PUSCH 上复用发送时，DMRS RE 不受 UCI 打孔或速率匹配影响。UCI 的 RE 映射遵循特定优先级规则：

```
PUSCH 时隙 RE 网格 (简化, 1 RB × 14 符号):

符号: 0  1  2  3  4  5  6  7  8  9 10 11 12 13
RE0   D  D  M  D  D  D  D  D  D  D  M  D  D  D    ← D=数据, M=DMRS
RE1   D  D  M  D  D  D  D  D  D  D  M  D  D  D
...   (Type 1 DMRS, 双符号前置+1附加位置)
RE11  D  D  M  D  D  D  D  D  D  D  M  D  D  D

UCI 映射规则:
1. DMRS RE 保留, UCI 不占用
2. HARQ-ACK 优先映射 (靠近 DMRS, 符号 1/3/10/12 的特定 RE)
3. CSI Part 1 次之
4. CSI Part 2 最后
5. PT-RS 其自身 RE 保留
```

**UCI RE 数量计算 (HARQ-ACK)**:

$$
Q'_{ACK} = \min\left\{
\frac{O_{ACK} \cdot M_{sc}^{PUSCH} \cdot N_{symb}^{PUSCH} \cdot \beta_{offset}^{HARQ-ACK}}{\sum_{r=0}^{C_{UL-SCH}-1} K_r},
\left\lceil \alpha \cdot M_{sc}^{PUSCH} \cdot N_{symb}^{PUSCH} \right\rceil
\right\}
$$

其中 $\beta_{offset}^{HARQ-ACK}$ 由 RRC 配置 ($\beta_{offset}^{HARQ-ACK} \in$ {1.0, 2.0, 2.5, ..., 126.0})，$\alpha$ 为 UCI 上限缩放因子 (RRC `scaling`)。

---

## 4. PUSCH UCI 复用

### 4.1 UCI 类型与优先级

当 PUCCH 与 PUSCH 在时域上冲突 (相同时隙或重叠)，UE 将 UCI 复用到 PUSCH 上发送。

| UCI 类型 | 内容 | 比特数 (典型) | 优先级 | 复用行为 |
|:--------|:----|:------------|:------|:--------|
| **HARQ-ACK** | 下行传输确认/否认 | 1~1706 bit | 最高 | 打孔 UL-SCH 数据 |
| **SR** | 调度请求 | 1~2 bit | 中 | 可与 HARQ-ACK 联合编码 |
| **CSI Part 1** | RI / CRI / CQI 第一码字 | 不定 (取决于 RI) | 高 | 速率匹配 UL-SCH |
| **CSI Part 2** | PMI / CQI 第二码字 | 不定 (取决于 Part 1) | 低 | 速率匹配 UL-SCH (可能被截断) |

> 注：当 PUSCH 上有 UL-SCH 数据时，使用 **速率匹配**；当 PUSCH 无 UL-SCH (仅 CSI 触发)，UCI 直接映射到全部可用 RE。

### 4.2 UCI RE 映射顺序

```
PUSCH RE 网格内的映射优先级 (从高到低):

1. DMRS RE                    — 始终保留
2. PT-RS RE (如果配置)        — 其自身 RE 保留
3. HARQ-ACK RE                — 打孔/速率匹配 UL-SCH
   └─ 映射在 DMRS 符号之后第一个可用非 DMRS 符号 (靠近 DMRS, 提高信道估计精度)
4. CSI Part 1 RE              — 速率匹配 UL-SCH
   └─ 从 PUSCH 首个可用非 DMRS 符号开始，逐符号、逐子载波映射
5. CSI Part 2 RE              — 速率匹配 UL-SCH
   └─ 紧接 CSI Part 1 之后映射
6. UL-SCH 数据 RE             — 映射到剩余 RE
```

```
一个 RB 内 UCI 映射示意 (Type 1 DMRS, 单前置 DMRS, 频域优先映射):

符号:    0    1    2    3    4    5    6    7    8    9   10   11   12   13
DMRS:         M                                                   M
子载波 ─────────────────────────────────────────────────────────────────→
  0:  [UL-SCH     ][HARQ   ][ CSI_P1 ][ CSI_P1 ][ CSI_P1 ][ UL-SCH     ]
  1:  [UL-SCH     ][HARQ   ][ CSI_P1 ][ CSI_P1 ][ CSI_P1 ][ UL-SCH     ]
  2:  [UL-SCH     ][  DMRS  ][ CSI_P1 ][ CSI_P2 ][ CSI_P2 ][ UL-SCH     ]
  ...
 11:  [UL-SCH     ][HARQ   ][ CSI_P1 ][ CSI_P1 ][ CSI_P1 ][ UL-SCH     ]

说明:
- HARQ-ACK RE 固定映射在 DMRS 符号两侧的符号 (符号 1 和 3)
- CSI Part 1 从符号 0 开始逐列填充
- CSI Part 2 放在 CSI Part 1 之后，通常靠近时隙尾部
```

### 4.3 UCI beta_offset 配置

`beta_offset` 控制 UCI 在 PUSCH 上的资源占用 (码率偏移)：

| UCI 类型 | beta_offset 范围 | RRC IE | 说明 |
|:--------|:----------------|:-------|:-----|
| HARQ-ACK | 1.000 ~ 126.000 (16 个离散值) | `BetaOffsets` → `betaOffsetACK-Index1/2/3` | 索引越大, UCI RE 越多, 可靠性越高 |
| CSI Part 1 | 1.125 ~ 62.000 | `BetaOffsets` → `betaOffsetCSI-Part1-Index1/2` | |
| CSI Part 2 | 同 CSI Part 1 | `BetaOffsets` → `betaOffsetCSI-Part2-Index1/2` | |

**beta_offset 语义**: 相对于 UL-SCH 数据的频谱效率偏移。$\beta_{offset}$ 越大, UCI 占用越多的 RE, 对应的 UCI 码率越低, 解码可靠性越高 (但 UL-SCH 吞吐下降)。

---

## 5. PUSCH 处理流程

### 5.1 完整处理链

```
                       PUSCH 发送处理链
═══════════════════════════════════════════════════════════════════════════

TB (传输块)
 │
 ├──[1] TB CRC 添加 ──────→ 24-bit CRC (CRC24A for TB > 3824, CRC16 otherwise)
 │
 ├──[2] CB 分段 ──────────→ 每 CB ≤ 8448 bit (BG1) / 3840 bit (BG2)
 │                          每个 CB 添加 24-bit CRC
 │
 ├──[3] LDPC 编码 ────────→ BG1 (大 TB, 高码率) / BG2 (小 TB, 低码率)
 │                          提升因子 Zc ∈ {2,...,384}
 │
 ├──[4] 速率匹配 ─────────→ 比特选择 (从环形缓冲器) + 比特交织
 │                          RV = {0, 1, 2, 3}, 支持 HARQ-IR
 │
 ├──[5] 码块级联 ──────────→ 将所有 CB 的速率匹配输出级联为一个码字
 │
 ├──[6] 加扰 ─────────────→ 加扰序列: c_init = n_RNTI × 2^15 + n_ID
 │                          (Gold 序列, 每码字独立)
 │
 ├──[7] 调制 ─────────────→ QPSK / 16QAM / 64QAM / 256QAM / 1024QAM
 │
 ├──[8] 层映射 ───────────→ 1/2/3/4 层 (CP-OFDM) 或 1 层 (DFT-s-OFDM)
 │
 ├──[9] 变换预编码 ───────→ (可选, DFT-s-OFDM 模式)
 │   (DFT 扩频)             M-point DFT, M 为分配的 RB × 12 个子载波
 │
 ├──[10] 预编码 ──────────→ 基于码本的预编码 (TPMI) 或 非码本预编码
 │                          (CP-OFDM 多天线场景)
 │
 ├──[11] RE 映射 ─────────→ 映射到分配的 VRB, 避开 DMRS/PT-RS 位置
 │                          VRB-to-PRB 映射 (非交织/交织)
 │
 └──[12] OFDM 调制 ───────→ N-point IFFT + CP 添加
     (或 SC-FDMA)
```

### 5.2 LDPC 编码 (步骤 3)

参见 [[nr-ldpc]] 完整分析。PUSCH LDPC 编码要点：

| 参数 | BG1 | BG2 |
|:----|:----|:----|
| 基矩阵大小 | 46 × 68 | 42 × 52 |
| 最大码块大小 | 8448 bit | 3840 bit |
| 适用码率 | 1/3 ~ 8/9 | 1/5 ~ 2/3 |
| 适用场景 | 大 TB / 高码率 eMBB | 小 TB / 低码率 URLLC |
| 循环提升因子 Zc | Zc = a × 2^j, a ∈ {2,3,5,7,9,11,13,15}, j=0~7 | 同 BG1 |

### 5.3 速率匹配 (步骤 4)

```
LDPC 编码输出 (N = 66×Zc for BG1, 50×Zc for BG2)
         │
         ▼
┌────────────────────┐
│  环形缓冲器         │
│  ┌──────────────┐  │
│  │ 系统比特      │  │ ← 先填充系统比特
│  │ (K - 2Zc)    │  │
│  ├──────────────┤  │
│  │ 校验比特 1    │  │
│  │ (Zc 列组)    │  │
│  ├──────────────┤  │
│  │ 校验比特 2    │  │
│  │ (Zc 列组)    │  │
│  └──────────────┘  │
│  RV:               │
│  RV0 → 系统比特起始 │
│  RV1 → 校验比特1    │
│  RV2 → 校验比特2    │
│  RV3 → 校验比特1    │
│       (不同起点)    │
└────────────────────┘
         │
         ▼
  比特选择 (k₀ 由 RV 确定) → E bit 输出 (E = 调制阶数 × 层数 × RE 数)
```

### 5.4 功率控制

PUSCH 功率控制公式 (TS 38.213 §7.1.1)：

$$
P_{\text{PUSCH},b,f,c}(i,j,q_d,l) = \min\left\{
\begin{aligned}
&P_{\text{CMAX},f,c}(i), \\
&P_{O\_PUSCH,b,f,c}(j) + 10\log_{10}(2^\mu \cdot M_{RB,b,f,c}^{PUSCH}(i)) \\
&\quad + \alpha_{b,f,c}(j) \cdot PL_{b,f,c}(q_d) + \Delta_{TF,b,f,c}(i) + f_{b,f,c}(i,l)
\end{aligned}
\right\} \text{ [dBm]}
$$

| 参数 | 含义 | 配置来源 | 典型值 |
|:----|:-----|:--------|:------|
| $P_{\text{CMAX}}$ | UE 最大发射功率 | UE 能力 + 法规限制 | 23 dBm (FR1 UE) / 26 dBm (FR2 UE) |
| $P_{O\_PUSCH}$ | 标称 PUSCH 功率 (含小区级 + UE 级分量) | RRC `p0-NominalWithGrant` + `p0-PUSCH-Alpha` | -80 ~ -60 dBm |
| $\alpha$ | 路径损耗补偿因子 (0~1, 步长 0.1) | RRC `alpha` in `P0-PUSCH-AlphaSet` | 0.8 ~ 1.0 |
| $PL$ | 下行路径损耗估计 (UE 侧测量) | UE 基于 SSB/CSI-RS 测量 | 80 ~ 140 dB |
| $M_{RB}$ | PUSCH 分配的 RB 数 | DCI 调度 | 1 ~ 275 |
| $\Delta_{TF}$ | MCS 相关的功率偏移 | 由调制阶数和码率计算 | -3 ~ +3 dB |
| $f(i,l)$ | TPC 累积/绝对值闭环调整 | DCI 中的 TPC 命令 (2 bit) | -4 ~ +4 dB (累积) |

**TPC 累积模式 vs 绝对值模式**:

| 模式 | 行为 | DCI TPC 字段映射 |
|:----|:-----|:---------------|
| **累积** (`tpc-Accumulation` 配置) | $f(i,l) = f(i-1,l) + \delta_{PUSCH}$ | {-1, 0, +1, +3} dB |
| **绝对值** | $f(i,l) = \delta_{PUSCH}$ (直接设置) | {-4, -1, +1, +4} dB |

---

## 6. PUCCH (物理上行控制信道)

### 6.1 PUCCH 功能概述

PUCCH 承载上行控制信息 (UCI)，在 UE 没有 PUSCH 发送时使用。

| UCI 类型 | 内容 | 触发 |
|:--------|:-----|:-----|
| **HARQ-ACK** | PDSCH 接收确认 (ACK/NACK) | 每次 PDSCH 接收后 |
| **SR** (Scheduling Request) | 请求 UL-SCH 资源 | UE 有上行数据要发送 |
| **CSI** (Channel State Information) | CRI/RI/PMI/CQI/LI | 周期/半持续/非周期上报 |

### 6.2 5 种 PUCCH Format

NR 定义了 5 种 PUCCH Format，分为两组：短 PUCCH (Format 0/2) 和长 PUCCH (Format 1/3/4)。

```
PUCCH Format 分类:

短 PUCCH (1~2 符号):                 长 PUCCH (4~14 符号):
┌──────────────────────┐             ┌────────────────────────────┐
│ Format 0: ≤2 bit     │             │ Format 1: ≤2 bit           │
│  序列选择,无DMRS      │             │  OOK + ZC 序列, 时域扩频    │
│                      │             │                            │
│ Format 2: >2 bit     │             │ Format 3: >2 bit           │
│  OFDM + DMRS, QPSK   │             │  DFT-s-OFDM, 无UE复用      │
└──────────────────────┘             │                            │
                                     │ Format 4: >2 bit           │
                                     │  DFT-s-OFDM + 多UE复用      │
                                     │  (时域OCC, pre-DFT OCC)    │
                                     └────────────────────────────┘
```

### 6.3 5 种 Format 完整对比

| 特性 | Format 0 | Format 1 | Format 2 | Format 3 | Format 4 |
|:----|:--------|:--------|:--------|:--------|:--------|
| **符号数** | 1 ~ 2 | 4 ~ 14 | 1 ~ 2 | 4 ~ 14 | 4 ~ 14 |
| **比特数** | ≤ 2 | ≤ 2 | > 2 | > 2 | > 2 |
| **波形** | CAZAC 序列 (ZC) | CAZAC 序列 (ZC) | CP-OFDM | DFT-s-OFDM | DFT-s-OFDM |
| **调制方式** | 序列选择 (CS) | OOK (时域扩频) | QPSK (可配) | QPSK (可配) | QPSK (可配) |
| **DMRS** | 无 (信息在 CS) | 与 UCI 时分复用 | 频分复用 (1/3 密度) | 时分复用 | 时分复用 |
| **多 UE 复用** | CS 复用 (12 个) | CS + OCC 复用 (最多 84) | FDM (频分) | 不支持 | OCC (时域 + pre-DFT) |
| **PRB 占用** | 1 PRB | 1 PRB | 1~16 PRB | 1~16 PRB | 1 PRB |
| **覆盖** | 较低 | 高 (最广) | 低 | 高 | 高 |
| **适用场景** | HARQ-ACK ≤2 bit, 低时延 | HARQ-ACK ≤2 bit, 广覆盖 | HARQ-ACK/CSI >2 bit, 时隙末尾 | HARQ-ACK/CSI >2 bit, 广覆盖 | 多 UE 共享资源, 大容量控制 |
| **典型部署** | 小区中心 | 小区边缘 | 小区中心, 大带宽 | 小区边缘, 大带宽 | 高密度 UE 场景 |

### 6.4 各 Format 详解

#### Format 0 (短 PUCCH, ≤2 bit)

```
原理: 通过 ZC 序列的循环移位 (CS) 携带信息

给定基序列 r(n), UE 发送:
  r_α(n) = r(n) × e^{jαn}

其中 α = 2π × m_cs / N_sc^RB

m_cs 由 UCI 比特映射:
  - 1 bit: m_cs ∈ {m_0, m_0 + 6}  (2 个状态)
  - 2 bit: m_cs ∈ {m_0, m_0 + 3, m_0 + 6, m_0 + 9}  (4 个状态)

频率:
  1-2 符号 × 1 PRB (12 子载波)
  支持跳频 (1 符号时不可跳频)

时域结构 (2 符号示例):
┌────────┬────────┐
│ Symbol │ Symbol │
│   0    │   1    │
│ CS=m_0 │ CS=m_3 │  ← 不同符号可用同一基序列 (不同跳频位置)
└────────┴────────┘
```

#### Format 1 (长 PUCCH, ≤2 bit)

```
原理: OOK (On-Off Keying) + 时域扩频

┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ DM │ UC │ UC │ UC │ DM │ UC │ UC │ UC │ DM │ UC │ UC │ UC │ DM │ UC │
│ RS │  I │  I │  I │ RS │  I │  I │  I │ RS │  I │  I │  I │ RS │  I │
└────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
  0    1    2    3    4    5    6    7    8    9   10   11   12   13

DMRS Sequence: ZC 序列 × 时域 OCC (w_i(m))
UCI: BPSK/QPSK 符号 × 时域 OCC (w_n(m))

时域 OCC 长度:
  - 符号 4~14: OCC length 2~7 (含 intra-slot 跳频调整)
  - UCI 符号组内 OCC → OOK: 发送 OCC 扩频信号 → 1; 不发送 → 0

多用户复用: CS (12) × 时域 OCC (最多 7) = 最多 84 个 UE 共享同一 PRB
```

#### Format 2 (短 PUCCH, >2 bit)

```
结构 (1-2 符号, 1-16 PRB):

┌──────────────────────┬──────────────────────┐
│      Symbol 0        │      Symbol 1        │
├────┬────┬────┬──┬────┼────┬────┬────┬──┬────┤
│ RE │ RE │ RE │DM│ RE │ RE │ RE │ RE │DM│ RE │
│UCI │UCI │UCI │RS│UCI │UCI │UCI │UCI │RS│UCI │
├────┼────┼────┼──┼────┼────┼────┼────┼──┼────┤
│ ...  (共 N_PRB × 12 RE, DMRS 密度 1/3)     │
└──────────────────────┴──────────────────────┘
  频域: UCI RE 和 DMRS RE 在频域交替 (FDM)
  调制: QPSK (可配置 pi/2-BPSK)
  
  最大载荷: ~500 bit (2 符号 × 16 PRB × 8 RE/PRB/符号 × 2 bit/符号 ≈ 512 bit)
```

#### Format 3 (长 PUCCH, >2 bit, 无多 UE 复用)

```
结构 (4-14 符号, 1-16 PRB, DFT-s-OFDM):

┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ DM │ UC │ DM │ UC │ UC │ DM │ UC │ UC │ DM │ UC │ UC │ DM │ UC │ UC │
│ RS │  I │ RS │  I │  I │ RS │  I │  I │ RS │  I │  I │ RS │  I │  I │
└────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
  0    1    2    3    4    5    6    7    8    9   10   11   12   13

DMRS 密度: 每 2 符号一组, 以 DMRS 起始 (4 符号时 DMRS 在符号 0,2)

处理步骤:
  UCI bit → 编码 (Reed-Muller / Polar) → 加扰 → QPSK →
  DFT 扩频 → 子载波映射 → IFFT → + CP

最大载荷: ~1706 bit (Rel-15) / 支持 Polar 编码长码块
```

#### Format 4 (长 PUCCH, >2 bit, 多 UE 复用)

```
与 Format 3 的区别: 增加多 UE 复用能力

┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ DM │ UC │ DM │ UC │ UC │ DM │ UC │ UC │ DM │ UC │ UC │ DM │ UC │ UC │
│ RS │  I │ RS │  I │  I │ RS │  I │  I │ RS │  I │  I │ RS │  I │  I │
└────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘

复用方式:
  pre-DFT OCC: 在 DFT 扩频之前对调制符号做时域 OCC
    (N_PUCCH_symbol ≥ 2 时, OCC length = 2 或 4)
  时域 OCC: DMRS 符号也有时域 OCC

多 UE 占用: 固定 1 PRB (与 Format 3 的区别)
  多用户通过不同 OCC 正交复用同一资源
```

### 6.5 PUCCH 资源分配

PUCCH 资源通过 RRC 配置，由 `PUCCH-Resource` IE 定义：

| 参数 | 说明 | 取值范围 |
|:----|:-----|:--------|
| `pucch-ResourceId` | 资源标识符 | 0 ~ 127 |
| `startingPRB` | 起始 PRB 索引 | 0 ~ 274 (BWP 内) |
| `intraSlotFrequencyHopping` | 时隙内跳频使能 | enabled / disabled |
| `secondHopPRB` | 第二跳 PRB 索引 | 0 ~ 274 (跳频使能时使用) |
| `format` | PUCCH 格式 | format0 / format1 / format2 / format3 / format4 |

**PUCCH 资源集 (PUCCH Resource Set)**:

```
PUCCH-Config 包含最多 4 个 PUCCH Resource Set:

Resource Set 0: 1~32 个 Format 0/1 资源 (≤2 bit, HARQ-ACK + SR)
Resource Set 1: 1~8 个 Format 0/1/2/3/4 资源 (1 < N_bits ≤ N₂)
Resource Set 2: 1~8 个 Format 2/3/4 资源 (N₂ < N_bits ≤ N₃)
Resource Set 3: 1~8 个 Format 2/3/4 资源 (N₃ < N_bits ≤ 1706)

其中 N₂, N₃ 由 RRC maxPayloadSize 配置

UE 根据 UCI 比特数选择资源集, 再根据 DCI 中的 PUCCH Resource Indicator (PRI, 3 bit)
选择资源集内的具体资源:
  - 资源集内 ≤ 8 个资源: PRI 直接索引
  - 资源集内 > 8 个资源: PRI + 隐式规则 (CCE index) 共同确定
```

---

## 7. PUCCH HARQ-ACK 时序

### 7.1 K1 参数 (PDSCH -> HARQ-ACK)

K1 表示 PDSCH 接收时隙与对应 HARQ-ACK 反馈 (在 PUCCH/PUSCH 上) 的时隙偏移量。

```
PDSCH 接收                               HARQ-ACK 反馈
时隙 n                                   时隙 n + K1
    │                                        │
    ├──── K1 个时隙 ────────────────────────→│
    │                                        │
    ▼                                        ▼
┌────────┐                              ┌────────┐
│ PDSCH  │                              │ PUCCH  │
│ TB     │                              │ACK/NACK│
└────────┘                              └────────┘
```

| 参数 | 取值范围 | 配置方式 |
|:----|:--------|:--------|
| K1 (时隙) | 0 ~ 15 (DCI 1_0) / 0 ~ 31 (DCI 1_1) | RRC `dl-DataToUL-ACK` 列表 (最多 8 个值), DCI 中的 PDSCH-to-HARQ_feedback timing indicator 索引列表条目 |
| 单位 | 时隙 (按 PUCCH 的 SCS) | PUCCH 和 PDSCH 子载波间隔可能不同, 需时隙偏移换算 |

**K1=0 的含义**: PDSCH 与 HARQ-ACK 在同一时隙 (仅 PDSCH 在时隙前部、PUCCH 在时隙后部时可行，类似自包含时隙)。

### 7.2 多码字 HARQ-ACK

| 场景 | HARQ-ACK 比特数 | 说明 |
|:----|:--------------:|:-----|
| 单码字 (1 TB) | 1 bit | ACK/NACK |
| 双码字 (2 TB) | 2 bit | 每 TB 独立 1 bit (空间捆绑禁用时) |
| 双码字 + 空间捆绑 | 1 bit | 两个 TB 的 ACK/NACK 做逻辑与 (仅当 RRC `harq-ACK-SpatialBundlingPUCCH` / `harq-ACK-SpatialBundlingPUSCH` 配置) |
| CBG 级别反馈 | 每 TB 最多 8 bit | RRC `maxCodeBlockGroupsPerTransportBlock` ∈ {2,4,6,8} |

**空间捆绑 (Spatial Bundling)**: 多码字场景下将多个 ACK/NACK 合并为单个 bit 以节省控制信道开销，适用于 PUCCH 资源受限时。

### 7.3 PUCCH Format 选择与 ACK 比特数

```
PUCCH Format 选择流程 (简化):

UCI 总比特数 (HARQ-ACK + SR + CSI)
         │
         ├─── ≤ 2 bit ────────────────────→ PUCCH Format 0 / 1
         │                                    (选 Format 0 还是 1 取决于:
         │                                     PUCCH 资源符号数 + 覆盖需求)
         │
         └─── > 2 bit ──── 符号数 ──┬── 1~2 符号 ──→ PUCCH Format 2
                                     │
                                     └── 4~14 符号 ─→ PUCCH Format 3 / 4
                                                       (选 3 还是 4 取决于:
                                                        是否需多 UE 复用)
```

### 7.4 HARQ-ACK 码本类型

NR 支持两种 HARQ-ACK 码本类型，决定反馈比特数量和映射方式：

#### Type-1: 半静态码本 (Semi-Static)

```
原理: 基于 RRC 配置的潜在 PDSCH 接收时机 (候选集合) 固定码本大小
      无论实际是否调度 PDSCH, 码本大小不变

优点: 码本大小固定, gNB 和 UE 对齐无歧义
缺点: 未调度时隙也占 bit, 开销大

码本大小 = 候选时隙数 × 候选分量载波数 × TB 数 (含 CBG)

配置: RRC pdsch-HARQ-ACK-Codebook = semiStatic
```

#### Type-2: 动态码本 (Dynamic)

```
原理: 基于实际调度的 PDSCH 构建码本, 通过 DAI (Downlink Assignment Index)
      计数器避免丢检

DAI 机制:
  - Counter DAI (cDAI): 当前 PDCCH 在本次反馈窗口内是第几个调度的
  - Total DAI (tDAI): 本次反馈窗口内累计调度了多少个 PDSCH (仅在 CA 场景使用)

优点: 开销小 (仅反馈实际调度的)
缺点: PDCCH 漏检可能导致码本大小错误

配置: RRC pdsch-HARQ-ACK-Codebook = dynamic
```

| 特性 | Type-1 (半静态) | Type-2 (动态) |
|:----|:--------------|:------------|
| 码本大小 | 固定 (由 RRC 配置决定) | 可变 (由 DAI 跟踪) |
| PDCCH 漏检鲁棒性 | 天然鲁棒 (固定大小) | 依赖 DAI (可能误判) |
| 开销 | 高 (所有候选时隙/CC 占位) | 低 (仅实际调度的) |
| DAI 需求 | 不需要 | 需要 (cDAI + tDAI) |
| 适用场景 | TDD 配置固定 / 小 CC 数 | CA 多载波 / 调度灵活 |

**Type-3 码本 (Rel-16)**: 支持 one-shot HARQ-ACK 反馈，将所有配置的 HARQ 进程的 ACK/NACK 状态一次性报告，适用于 URLLC 和免调度场景。

---

## 8. SRS (探测参考信号)

### 8.1 SRS 功能概述

SRS (Sounding Reference Signal) 是 UE 发送的上行参考信号，gNB 通过测量 SRS 获取上行信道状态信息，用于：

| 功能 | 说明 | 受益信道 |
|:----|:-----|:--------|
| **上行频率选择性调度** | gNB 根据 SRS 测量结果选择最佳 RB 分配给 UE | PUSCH |
| **上行预编码计算** | 基于 SRS 信道估计计算上行传输预编码矩阵 | PUSCH (码本/非码本) |
| **下行预编码计算 (TDD 信道互易性)** | TDD 模式下利用互易性，从 SRS 推导下行预编码 | PDSCH (尤其 FR2 大规模 MIMO) |
| **上行波束管理** | FR2 SRS 多波束扫描确定最佳上行波束 | PUSCH, PUCCH, SRS |
| **天线切换探测** | UE 多天线上行轮流发送 SRS，gNB 获取完整信道矩阵 | PDSCH (TDD 互易性) |
| **定位** | SRS 用于 NR 定位 (UL-TDOA / UL-AoA) | 定位参考 |

### 8.2 SRS 资源配置

SRS 资源通过 `SRS-Resource` IE 定义：

| 参数 | 说明 | 取值范围 |
|:----|:-----|:--------|
| `srs-ResourceId` | 资源标识符 | 0 ~ 63 |
| `nrofSRS-Ports` | SRS 天线端口数 | 1, 2, 4 |
| `transmissionComb` | 梳状结构 | n2 (comb-2), n4 (comb-4) |
| `combOffset` | 梳状偏移 | 0 ~ 1 (comb-2) / 0 ~ 3 (comb-4) |
| `nrofSymbols` | SRS 占用符号数 | 1, 2, 4 |
| `startPosition` | 时隙内起始符号 | 0 ~ 13 (最后 6 个符号内) |

**梳状结构 (Transmission Comb)**:

```
Comb-2 (n2):                           Comb-4 (n4):
频域 (1 RB = 12 RE)                    频域 (1 RB = 12 RE)
┌────┐                                  ┌────┐
│ RE │ Comb0 Comb1                      │ RE │ C0 C1 C2 C3
├────┤                                  ├────┤
│ 11 │  SRS                              │ 11 │  SRS
│ 10 │        SRS                        │ 10 │          SRS
│  9 │  SRS                              │  9 │      SRS
│  8 │        SRS                        │  8 │  SRS
│ ...│  ...   ...                        │ ...│  ... ... ... ...
│  0 │  SRS                              │  0 │          SRS
└────┘                                  └────┘
  2 个 UE 可频分复用                     4 个 UE 可频分复用
  每个 UE 每 2 RE 发送一个 SRS            每个 UE 每 4 RE 发送一个 SRS
```

| Comb | 频域密度 | 最大复用 UE 数 | 每 UE 信道估计质量 |
|:----:|:-------:|:------------:|:---------------:|
| n2 | 50% (每 2 RE 1 个) | 2 | 较高 |
| n4 | 25% (每 4 RE 1 个) | 4 | 较低 |

### 8.3 SRS 符号配置

```
时隙末尾灵活符号区:

┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │11 │12 │13 │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
  ◄───────────────── 数据/控制 ──────────────►◄─ SRS ──►
                                                (最后 1/2/4 符号)

nrofSymbols = 1: 仅符号 13
nrofSymbols = 2: 符号 12-13
nrofSymbols = 4: 符号 10-13
```

### 8.4 SRS 跳频与天线切换

#### 跳频 (Frequency Hopping)

SRS 跳频允许 UE 在多个符号上跳频扫描更宽带宽：

```
未跳频: 一跳覆盖全 SRS 带宽
┌──────────────────────┐
│    SRS BW (固定)      │  1 符号
└──────────────────────┘

跳频 (nrofSymbols=4, 4 跳):
┌──────┬──────┬──────┬──────┐
│ Hop1 │ Hop2 │ Hop3 │ Hop4 │  4 个符号
└──────┴──────┴──────┴──────┘
 ◄──────── SRS 总带宽 ────────►

每跳带宽 = 总带宽 / N_hops
跳频参数: C_SRS, B_SRS, b_hop (RRC 配置)
```

| 参数 | 说明 |
|:----|:-----|
| `C_SRS` | SRS 带宽配置索引 (0~63), 决定 SRS 总带宽 |
| `B_SRS` | SRS 跳频带宽索引 (0~3), B_SRS=0 → 不跳频; B_SRS>0 → 跳频使能 |
| `b_hop` | 跳频起始层级, b_hop < B_SRS → 跳频 |

#### 天线切换 (Antenna Switching)

UE 在多天线间轮流发送 SRS，使 gNB 获取完整的信道矩阵 (TDD 互易性)：

```
天线切换配置 (1T2R 示例, 2 个 SRS 资源):

┌──────────────────────────────────────┐
│ 资源 1 (天线 0 发送):                  │
│   Port 0 → UE 天线 0                 │
│                                      │
│ 资源 2 (天线 1 发送):                  │
│   Port 0 → UE 天线 1                 │
└──────────────────────────────────────┘

常见天线切换模式:
  1T2R: 1 发送通道, 2 接收天线 (SRS 轮发两次)
  2T4R: 2 发送通道, 4 接收天线 (SRS 轮发两次, 每次两个天线)
  1T4R: 1 发送通道, 4 接收天线 (SRS 轮发四次)
```

| 天线配置 | SRS 资源数 | 每资源 Port 数 | 总轮询次数 |
|:--------|:---------:|:------------:|:--------:|
| 1T1R | 1 | 1 | 1 |
| 1T2R | 2 | 1 | 2 |
| 2T4R | 2 | 2 | 2 |
| 1T4R | 4 | 1 | 4 |

### 8.5 SRS Spatial Relation

`spatialRelationInfo` 指示 SRS 发送的空间滤波 (波束) 参考：

| 参考信号类型 | 说明 | 适用场景 |
|:-----------|:-----|:--------|
| **SSB-Index** | 以 SSB 波束为参考 | 初始接入后, 波束对应 |
| **CSI-RS-Index** | 以 CSI-RS 波束为参考 | 连接态, 更精细波束 |
| **SRS-ResourceId** | 以另一 SRS 资源为参考 (级联) | 波束管理, SRS 间关联 |

```
SRS Spatial Relation 配置:

UE                                          gNB
 │                                            │
 │←── RRC: SRS-Resource.spatialRelationInfo ─│
 │     { referenceSignal: SSB-Index #N }      │
 │                                            │
 │──── SRS ────────────────────────────────→│
 │     (使用与 SSB#N 相同的空间滤波器发送)      │
 │                                            │
 │←── gNB 测量 SRS, 选择最佳波束 ────────────│
```

**FR2 (毫米波) 的特殊性**: 在 FR2，UE 使用模拟/混合波束赋形，`spatialRelationInfo` 决定 UE 的发送波束方向。无 `spatialRelationInfo` 配置时，UE 可自主选择发送波束。

### 8.6 SRS 资源集 (SRS Resource Set)

SRS 资源组织为资源集 (`SRS-ResourceSet`)，每个资源集定义使用方式：

| `usage` 参数 | 用途 | 说明 |
|:------------|:-----|:-----|
| `beamManagement` | 波束管理 | 每个资源用不同波束发送, gNB 测量选最优波束 (仅 FR2) |
| `codebook` | 基于码本的上行预编码 | gNB 根据 SRS 测量选择 TPMI 和 TRI |
| `nonCodebook` | 非码本上行预编码 | UE 自主计算预编码 (利用 SRS 信道互易性) |
| `antennaSwitching` | 天线切换探测 | 获取完整 DL 信道矩阵 (TDD 互易性) |

---

## 附录: 关键 3GPP 协议参考

| 协议章节 | 内容 | 本文对应 |
|:--------|:-----|:--------|
| TS 38.211 §6.2 | PUSCH 物理资源映射 | 第 2 节 |
| TS 38.211 §6.3 | PUSCH DMRS | 第 3 节 |
| TS 38.211 §6.3.1 | PUSCH DMRS (CP-OFDM) | 第 3.2 节 |
| TS 38.211 §6.3.2 | PUSCH DMRS (DFT-s-OFDM) | 第 3.4 节 |
| TS 38.211 §6.3.3 | PUSCH PT-RS | -- |
| TS 38.211 §6.4 | PUSCH SC-FDMA 基带信号生成 | 第 5 节 |
| TS 38.211 §6.4.1 | PUCCH Format 0/1/2/3/4 | 第 6 节 |
| TS 38.211 §6.4.1.5 | SRS | 第 8 节 |
| TS 38.212 §5 | UL-SCH 信道编码 (LDPC) | 第 5.2 节 |
| TS 38.212 §6.1 | UCI 编码 | 第 4 节 |
| TS 38.212 §6.3 | UCI 信道编码 (PUCCH) | 第 6 节 |
| TS 38.212 §7 | 速率匹配 | 第 5.3 节 |
| TS 38.213 §7 | UE PUSCH 发送过程 | 第 1-2 节 |
| TS 38.213 §7.1 | PUSCH 功率控制 | 第 5.4 节 |
| TS 38.213 §7.2 | PUSCH UCI 复用 | 第 4 节 |
| TS 38.213 §8 | UE PUCCH 发送过程 | 第 6-7 节 |
| TS 38.213 §9 | UE SRS 发送过程 | 第 8 节 |
| TS 38.214 §6.1 | PUSCH 资源分配 | 第 2 节 |
| TS 38.214 §6.1.2 | PUSCH 时域资源分配 (SLIV/K2) | 第 1.4, 2.2 节 |

---

*文档版本: v1.0 | 生成方式: 人工 + AI 辅助 | 许可: 内部使用*
