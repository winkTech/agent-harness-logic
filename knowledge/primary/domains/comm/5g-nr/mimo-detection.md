---
algorithm: "5G NR MIMO检测与预编码"
version: "1.0"
status: "draft"
created: "2026-06-04"
tags: [comm, 5g-nr, mimo, detection, precoding, csi, mu-mimo]
---

# 5G NR MIMO 检测与预编码

> 最后更新: 2026-06-04
> 关联: [[overview]], [[nr-frame-structure]], [[../ldpc/algorithm_spec]], [[../ofdm/algorithm_spec]]
> 参考: 3GPP TS 38.211 §7.2-7.4, TS 38.212 §5.2, TS 38.214 §5.2

---

## 1. NR MIMO 概述

### 1.1 NR MIMO 能力

5G NR 大幅提升了 MIMO 天线配置能力，远超 LTE：

| 方向 | 最大层数 | 最大天线端口 | 典型配置 | 峰值谱效率提升 |
|:----:|:-------:|:----------:|:--------:|:------------:|
| **DL** | 16 层 | 32 端口 | 64T64R | 16x (相对 SISO) |
| **UL** | 8 层 | 8 端口 | 4T4R / 8T8R | 8x (相对 SISO) |

NR 的 MIMO 扩展得益于：
- **大规模 MIMO (Massive MIMO)**: gNB 侧 64~256 天线阵元，利用波束赋形实现空间复用
- **全维度 MIMO (FD-MIMO)**: 二维天线面板 (水平 + 垂直)，支持 3D 波束赋形
- **毫米波波束管理**: FR2 (24.25~52.6 GHz) 依赖窄波束扫描建立初始连接

### 1.2 SU-MIMO vs MU-MIMO

| 特性 | SU-MIMO | MU-MIMO |
|:----|:--------|:--------|
| **定义** | 单用户占用全部空间层 | 多用户共享空间层 |
| **最大层数/用户** | DL 8 / UL 4 (R15) | DL 4 / UL 2 (典型) |
| **总层数** | 受限于 UE 天线数 | 受限于 gNB 天线数 |
| **信道状态信息** | PMI 反馈 | PMI + 用户配对信息 |
| **调度复杂度** | 低 | 高 (需正交配对) |
| **小区吞吐量** | 峰值速率高 | 平均吞吐量高 |
| **适用场景** | 低负载, 高 SINR | 高负载, 多用户 |

**NR 增强** (R16/R17): 支持每用户最多 4 层 (DL) + 多 TRP 联合传输。

### 1.3 码本传输 vs 非码本传输

```
码本传输 (Codebook-Based):
  gNB 发送 CSI-RS → UE 测量 → PMI 反馈 → gNB 查码本选预编码矩阵

非码本传输 (Non-Codebook-Based):
  UE 发送 SRS → gNB 信道互易性估计 DL 信道 → 直接计算预编码矩阵
```

| 特性 | 码本传输 | 非码本传输 |
|:----|:--------|:----------|
| **依赖** | PMI 反馈 (FDD/TDD) | SRS 测量 (TDD 信道互易性) |
| **预编码精度** | 量化误差 (码本分辨率限制) | 无量化误差 (任意矩阵) |
| **反馈开销** | PMI/CQI/RI (数 bit 到数十 bit) | 无 (gNB 自行计算) |
| **适用双工** | FDD + TDD | TDD 为主 |
| **天线校准** | 无严格要求 | 要求收发天线校准 |
| **NR 支持** | 所有场景 | 仅 TDD (channelReciprocity) |

### 1.4 DMRS 类型

DMRS (解调参考信号) 用于 PDSCH/PUSCH 的信道估计和数据解调。

#### DMRS 映射类型 (Mapping Type)

```
Type A (基于时隙):
  ┌────────────┬──────────────────────────────────┐
  │ PDCCH      │ DMRS (符号 2/3) + PDSCH           │
  └────────────┴──────────────────────────────────┘
  DMRS 起始位置固定 (符号 2 或 3)
  适用: eMBB, 基于时隙调度

Type B (基于符号):
  ┌────────────┬──────────────────────────────────┐
  │ PDCCH      │ DMRS (首个 PDSCH 符号) + PDSCH    │
  └────────────┴──────────────────────────────────┘
  DMRS 起始位置 = PDSCH 起始符号
  适用: URLLC, mini-slot 调度
```

#### DMRS 配置类型 (Configuration Type)

| 特性 | Type 1 | Type 2 |
|:----|:------|:------|
| **频域密度** | 每 PRB 6 个 RE (交替子载波) | 每 PRB 4 个 RE (2 组, 2 子载波间隔) |
| **最大正交端口数** | 8 (单符号) / 16 (双符号) | 12 (单符号) / 24 (双符号) |
| **多用户配对** | 最多 4 UE (每 UE 2 层) | 最多 6 UE (每 UE 2 层) |
| **CDM 方式** | FD-OCC (长度 2) | FD-OCC (长度 2) + TD-OCC (双符号) |
| **适用场景** | 单 TRP, 层数 ≤ 8 | 多 TRP, 层数 ≤ 12 |

---

## 2. 系统模型

### 2.1 基本 MIMO 系统模型

MIMO 系统频域接收信号：

$$y = Hx + n$$

其中：

| 符号 | 维度 | 含义 |
|:----|:----|:-----|
| $y$ | $N_r \times 1$ | 接收信号向量 |
| $H$ | $N_r \times N_t$ | MIMO 信道矩阵 |
| $x$ | $N_t \times 1$ | 发射信号向量 |
| $n$ | $N_r \times 1$ | 加性复高斯噪声, $n \sim \mathcal{CN}(0, \sigma^2 I)$ |

**展开形式** ($N_t$ 发送, $N_r$ 接收):

$$
\begin{bmatrix}
y_1 \\ y_2 \\ \vdots \\ y_{N_r}
\end{bmatrix} =
\begin{bmatrix}
h_{11} & h_{12} & \cdots & h_{1N_t} \\
h_{21} & h_{22} & \cdots & h_{2N_t} \\
\vdots & \vdots & \ddots & \vdots \\
h_{N_r 1} & h_{N_r 2} & \cdots & h_{N_r N_t}
\end{bmatrix}
\begin{bmatrix}
x_1 \\ x_2 \\ \vdots \\ x_{N_t}
\end{bmatrix} +
\begin{bmatrix}
n_1 \\ n_2 \\ \vdots \\ n_{N_r}
\end{bmatrix}
$$

### 2.2 信道矩阵 $H$

**维度**: $N_r \times N_t$ (接收天线数 × 发送天线数)

**每元素 $h_{ij}$**: 第 $j$ 根发射天线到第 $i$ 根接收天线的复信道增益。

**秩 (Rank)**: $\text{rank}(H) \leq \min(N_t, N_r)$，决定了可支持的最大空间流数。

**条件数**: $\kappa(H) = \frac{\sigma_{\max}}{\sigma_{\min}}$，衡量信道矩阵的可逆性：
- $\kappa \approx 1$: 信道条件良好，各层信号强度均衡
- $\kappa \gg 1$: 信道病态，ZF/MMSE 检测噪声放大严重

### 2.3 信道模型

NR 标准定义了两类空间信道模型 (3GPP TR 38.901)：

| 模型 | 全称 | 特征 | 适用场景 |
|:----|:----|:----|:--------|
| **CDL** | Clustered Delay Line | 簇 + 角度参数 (AoA/AoD/AS) | 链路级仿真 |
| **TDL** | Tapped Delay Line | 抽头延迟线, 简化模型 | 快速校准仿真 |

**空间相关性模型 (Kronecker)**:

$$R = R_t \otimes R_r$$

其中 $R_t$ ($N_t \times N_t$) 和 $R_r$ ($N_r \times N_r$) 分别为发射和接收侧相关矩阵。

相关 MIMO 信道:

$$H_{corr} = R_r^{1/2} \cdot H_{iid} \cdot R_t^{1/2}$$

其中 $H_{iid}$ 为独立同分布瑞利信道。

| CDL 模型 | 簇数 | 主要特征 | 典型场景 |
|:--------|:---:|:--------|:--------|
| CDL-A | 23 | 高角度扩展 | NLOS 城市宏站 |
| CDL-B | 23 | 中角度扩展 | NLOS 城市微站 |
| CDL-C | 24 | 低角度扩展 | LOS 农村宏站 |
| CDL-D | 13 | 强 LOS 分量 | LOS 城市微站 |
| CDL-E | 14 | 极强 LOS 分量 | LOS 室内热点 |

---

## 3. MIMO 检测算法对比

### 3.1 ZF (Zero-Forcing)

**核心思想**: 强制消除层间干扰，不考虑噪声影响。

**检测矩阵**:

$$W_{ZF} = (H^H H)^{-1} H^H$$

**检测输出**:

$$\hat{x}_{ZF} = W_{ZF} \cdot y = x + (H^H H)^{-1} H^H n$$

**后检测 SNR** (第 $k$ 层):

$$\text{SINR}_k = \frac{\mathbb{E}[|x_k|^2]}{\sigma^2 \cdot [(H^H H)^{-1}]_{kk}}$$

**噪声放大问题**:
当 $H$ 接近奇异 ($\kappa(H)$ 大) 时，$(H^H H)^{-1}$ 的对角元素急剧增大，导致噪声被显著放大。

```
数值示例:
  H = [1   0.99]  →  κ(H) ≈ 199  (接近奇异)
       [0.99 1  ]

  (H^H H)^{-1} ≈ [2500  -2475]
                  [-2475  2500]

  → 噪声方差放大 ~2500 倍 (= 34 dB 损失)
```

**复杂度**: $O(N_r N_t^2 + N_t^3)$ (矩阵乘法 + 求逆)

### 3.2 MMSE (Minimum Mean Square Error)

**核心思想**: 最小化均方误差 $\mathbb{E}[\|x - \hat{x}\|^2]$，在干扰抑制与噪声抑制之间取得平衡。

**检测矩阵**:

$$W_{MMSE} = (H^H H + \sigma^2 I)^{-1} H^H$$

其中 $\sigma^2$ 为噪声方差。

**等效扩展信道形式**:

$$W_{MMSE} = (\tilde{H}^H \tilde{H})^{-1} \tilde{H}^H$$

其中 $\tilde{H} = \begin{bmatrix} H \\ \sigma I \end{bmatrix}$ 为扩展信道矩阵 ($(N_r + N_t) \times N_t$)。

**后检测 SINR** (第 $k$ 层):

$$\text{SINR}_k = \frac{1}{\sigma^2 \cdot [(H^H H + \sigma^2 I)^{-1}]_{kk}} - 1$$

**MMSE vs ZF 对比**:

| SNR 区域 | ZF 行为 | MMSE 行为 | 性能差距 |
|:--------|:------|:---------|:--------|
| 低 SNR (< 0 dB) | 噪声主导, 性能急剧恶化 | 回归匹配滤波, 抑制噪声 | MMSE 优势显著 (> 3 dB) |
| 中 SNR (0~15 dB) | 干扰+噪声共同作用 | 自适应平衡 | MMSE 优势 1~3 dB |
| 高 SNR (> 15 dB) | 干扰主导, 趋近 MMSE | 趋近 ZF | 差距 < 0.5 dB |

**MMSE 实现复杂度**: $O(N_r N_t^2 + N_t^3)$ (与 ZF 同级, 仅增加对角加载 $\sigma^2 I$)

### 3.3 MLD (Maximum Likelihood Detection)

**核心思想**: 在所有可能的发送向量中，寻找使接收信号似然函数最大化的那个。

**检测准则**:

$$\hat{x}_{ML} = \arg\min_{x \in \mathcal{X}^{N_t}} \|y - Hx\|^2$$

其中 $\mathcal{X}$ 为调制星座集合 (QPSK/16QAM/64QAM/256QAM)。

**复杂度**:
- 穷举搜索: $O(|\mathcal{X}|^{N_t})$ — 指数增长
- QPSK, $N_t = 4$: 需评估 $4^4 = 256$ 个候选
- 256QAM, $N_t = 8$: 需评估 $256^8 \approx 1.8 \times 10^{19}$ 个 — 完全不可行

**球形译码 (Sphere Decoder)**:

简化 MLD 的常用方法。仅搜索以接收点 $y$ 为中心、半径为 $d$ 的超球面内的候选向量：

$$\|y - Hx\|^2 \leq d^2$$

通过 QR 分解 $H = QR$ 将搜索问题转化为树搜索：

$$\|y - Hx\|^2 = \|Q^H y - Rx\|^2 = \sum_{k=1}^{N_t} \left| \tilde{y}_k - \sum_{j=k}^{N_t} r_{kj} x_j \right|^2$$

自底向上逐层搜索 (SD 深度优先)，利用半径约束剪枝。

| SD 类型 | 策略 | 复杂度 | ML 最优性 |
|:-------|:----|:------|:--------|
| **Fincke-Pohst** | 固定半径, 深度优先 | 平均 $O(N_t^3)$, 最差指数 | 是 |
| **Schnorr-Euchner** | 动态半径 + 最优排序 | 低于 FP-SD | 是 |
| **K-Best** | 广度优先, 每层保留 K 个路径 | $O(K \cdot N_t^2)$ | 近 ML (K 足够大) |
| **Fixed-Complexity SD** | 固定展开模式 | 确定的 $O(N_t^3)$ | 近 ML |

### 3.4 LMMSE-IRC (Interference Rejection Combining)

**问题**: 纯 MMSE 假设干扰+噪声为白噪声 ($\sigma^2 I$)，实际网络中邻区干扰是有色的。

**IRC 检测矩阵**:

$$W_{IRC} = H^H (H H^H + R)^{-1}$$

其中 $R = \mathbb{E}[(y_{int} + n)(y_{int} + n)^H]$ 为干扰+噪声协方差矩阵。

**与基本 MMSE 的关键区别**:

| 特征 | MMSE | LMMSE-IRC |
|:----|:----|:----------|
| **干扰假设** | 白噪声 ($\sigma^2 I$) | 有色干扰 ($R$ 满矩阵) |
| **协方差估计** | 仅需标量 $\sigma^2$ | 需估计完整 $R$ 矩阵 |
| **邻区抑制** | 无 | 利用干扰空间结构抑制 |
| **自由度消耗** | 0 | 每强干扰源消耗 1 个 Rx 自由度 |
| **复杂度增量** | — | +$O(N_r^3)$ (协方差估计 + Cholesky) |

**NR 推荐**: 3GPP 将 LMMSE-IRC 作为 NR 接收机的推荐实现，尤其适用于小区边缘场景。

**干扰协方差估计** (数据辅助):

$$R = \frac{1}{N_{RE}} \sum_{k=1}^{N_{RE}} (y_k - H_k \hat{x}_k)(y_k - H_k \hat{x}_k)^H$$

使用 DMRS 或初始检测后的重构信号估计 $R$。

### 3.5 检测算法综合对比

| 算法 | 计算复杂度 | 误码性能排序 | 是否需要噪声估计 | 是否需要干扰协方差 | NR 适用性 |
|:----|:--------:|:----------:|:-------------:|:----------------:|:--------|
| **ZF** | $O(N_r N_t^2)$ | 4 (最差) | 否 | 否 | 高 SNR 场景, 快速原型 |
| **MMSE** | $O(N_r N_t^2)$ | 3 | 是 ($\sigma^2$) | 否 | 通用基准接收机 |
| **LMMSE-IRC** | $O(N_r N_t^2 + N_r^3)$ | 2 | 是 | 是 ($R_{N_r \times N_r}$) | **NR 推荐** |
| **MLD/SD** | $O(M^{N_t})$ (最差) | 1 (最优) | 是 | 可选 | 层数少时 ($N_t \leq 4$) |

**算法选择指南**:

```
层数 →  N_t ≤ 2          N_t ≤ 4            N_t ≤ 8           N_t ≤ 16
        ┌─────────┐    ┌──────────────┐   ┌──────────────┐   ┌───────────┐
低SNR    │  MLD    │    │  球形译码     │   │  LMMSE-IRC   │   │  MMSE-IRC │
中SNR    │  或球形  │    │  LMMSE-IRC   │   │              │   │           │
高SNR    │  ZF/MMSE│    │  MMSE / ZF   │   │  ZF / MMSE   │   │  近似算法  │
        └─────────┘    └──────────────┘   └──────────────┘   └───────────┘
```

---

## 4. 预编码 (Precoding)

### 4.1 预编码原理

预编码在发射端对信号进行预处理，使接收端分离各空间层：

```
x = W · s

其中: s — 层映射数据向量 (N_layer × 1)
      W — 预编码矩阵 (N_t × N_layer)
      x — 天线端口信号 (N_t × 1)
```

接收端等效信道:

$$y = H W s + n = H_{eff} \cdot s + n$$

预编码的目标是使 $H_{eff} = HW$ 具有良好的结构 (对角化，便于检测)。

### 4.2 基于码本的预编码 (Codebook-Based)

#### Type I 码本 (单用户, 高分辨率)

**用途**: SU-MIMO，单一用户占用所有空间层。

**单天线面板码本结构** ($N_1 \times N_2$ 天线端口):

$$W = W_1 \cdot W_2$$

| 分量 | 含义 | 维度 | 反馈周期 |
|:----|:----|:----|:--------|
| $W_1$ | 宽带波束组选择 (DFT 波束) | $N_t \times 2L$ | 长期/宽带 |
| $W_2$ | 子带波束选择 + 同相合并 | $2L \times N_{layer}$ | 短期/子带 |

$L$ 为每极化方向的波束数:
- $L = 2$ (低分辨率, 小反馈)
- $L = 4$ (高分辨率, 大反馈)

**Type I 多面板码本** ($N_g$ 个面板):

$$W = \begin{bmatrix} W_{panel,1} \\ \vdots \\ W_{panel,N_g} \end{bmatrix}$$

每个面板独立配置，面板间通过 $W_2$ 中的同相因子合并。

#### Type II 码本 (多用户, DFT 压缩)

**用途**: MU-MIMO, 高精度 CSI 反馈。

**Type II 码本结构**:

$$W = W_1 \cdot W_2 \cdot W_f^H$$

| 分量 | 含义 | 维度 |
|:----|:----|:----|
| $W_1$ | 空间域基 (相同于 Type I) | $N_t \times 2L$ |
| $W_2$ | 线性组合系数矩阵 | $2L \times M$ |
| $W_f$ | 频域基 (DFT 压缩) | $N_{SB} \times M$ |

$M$ 为频域压缩基数量 ($M \ll N_{SB}$)，通过频域 DFT 压缩大幅削减反馈开销。

**Type II 增强 (R16 eType II)**:

| 特性 | R15 Type II | R16 eType II |
|:----|:----------|:------------|
| 频域压缩 | 否 (全子带上报) | 是 (DFT 压缩) |
| 反馈开销 | $O(N_{SB} \cdot L)$ | $O(M \cdot L)$, $M \ll N_{SB}$ |
| 秩最大 | 2 | 4 |
| 每层比特数 | ~1500 bit (32 子带, L=4, R=2) | ~300 bit (M=7, L=4, R=2) |
| 开销削减 | — | ~80% |

#### PMI/CQI/RI 上报

| 参数 | 全称 | 含义 | 量化 |
|:----|:----|:----|:----|
| **RI** | Rank Indicator | 推荐的空间层数 | 1~8 (DL), 1~4 (UL) |
| **PMI** | Precoding Matrix Indicator | 推荐的预编码矩阵索引 | $i_{1,1}, i_{1,2}, i_{1,3}, i_2$ |
| **CQI** | Channel Quality Indicator | 推荐 MCS/码率 | 0~15 (每码字) |
| **LI** | Layer Indicator | 最强层索引 | 1~RI |
| **CRI** | CSI-RS Resource Indicator | 推荐 CSI-RS 资源 | 1~CSI-RS 资源数 |

### 4.3 非码本预编码 (Non-Codebook-Based)

**核心**: gNB 利用 TDD 信道互易性，从 UE SRS 测量直接推导 DL 预编码。

**流程**:

```
┌─────────┐    SRS (UL)    ┌─────────┐
│   UE    │ ──────────────→ │   gNB   │
└─────────┘                 └─────────┘
                                 │
                            SRS 信道估计 → H_UL
                                 │
                            TDD 互易性: H_DL ≈ H_UL^T
                                 │
                            SVD 分解: H_DL = U Σ V^H
                                 │
                            预编码矩阵: W = V(:, 1:N_layer)
                                 │
                                 ▼
                            ┌─────────┐
                            │  NLOS   │
                            │ 预编码  │
                            │ PDSCH   │
                            └─────────┘
```

**SVD 预编码** (理论最优):

$$H = U \Sigma V^H$$

取 $V$ 的前 $N_{layer}$ 列作为预编码矩阵: $W = V_{1:N_{layer}}$

等效信道: $H W = \Sigma_{1:N_{layer}}$ (对角化)

**ZF 预编码** (MU-MIMO 常用):

$$W_{ZF} = H^H (H H^H)^{-1}$$

使多用户间干扰归零。

---

## 5. 信道状态信息 (CSI) 框架

### 5.1 CSI-RS 配置

NR CSI 框架依赖两类参考信号：

| 信号 | 全称 | 用途 | 密度 |
|:----|:----|:----|:----|
| **NZP CSI-RS** | Non-Zero-Power CSI-RS | 信道测量 ($H$) | 每 PRB 1~3 RE (可配) |
| **CSI-IM** | CSI Interference Measurement | 干扰测量 ($R$) | 每 PRB 4 RE |
| **ZP CSI-RS** | Zero-Power CSI-RS | 速率匹配 (PDSCH 打孔) | 同关联 NZP CSI-RS |

**CSI-RS 资源配置**:

```
时频图 (1 PRB, 1 时隙):
        ┌────────────────────────────┐
频域     │  ... PDSCH RE ...         │
        │  CSI-RS (3 RE)             │
        │  PDSCH                     │
        │  CSI-IM (4 RE, 零功率)     │
        │  PDSCH                     │
        │  DMRS + PDSCH              │
        └────────────────────────────┘
                  时间 →
```

**CSI-RS 天线端口数**: 1, 2, 4, 8, 12, 16, 24, 32

### 5.2 CSI 报告类型

| 上报类型 | 触发机制 | 传输信道 | 典型周期 | 适用场景 |
|:--------|:--------|:--------|:--------|:--------|
| **周期 CSI (P-CSI)** | RRC 配置 | PUCCH (短/长格式) | 2~640 时隙 | 稳态信道, 低开销 |
| **半持续 CSI (SP-CSI)** | MAC CE 激活/去激活 | PUCCH / PUSCH | RRC 配置 + MAC CE 开关 | 中间态, 数据突发 |
| **非周期 CSI (A-CSI)** | DCI 触发 (CSI request) | PUSCH | 单次 | 突发需求, 大报告量 |

### 5.3 CSI 报告内容

```
┌─────────────────────────────────────────┐
│               CSI 报告                   │
├───────────────┬─────────────────────────┤
│ 宽带 (Wideband) │ 子带 (Subband)          │
├───────────────┼─────────────────────────┤
│  CRI          │  PMI (W2 子带部分)       │
│  RI           │  CQI (每子带每码字)        │
│  PMI (W1)     │  LI (可选)               │
│  CQI (宽带)    │                         │
│  LI (可选)     │                         │
└───────────────┴─────────────────────────┘
```

**CQI 表选择** (TS 38.214 §5.2.2.1):

| CQI 表 | 调制阶数 | 最高码率 | 最高谱效 | 场景 |
|:------:|:-------:|:-------:|:-------:|:----|
| Table 1 | 64QAM | 948/1024 | 5.55 bps/Hz | eMBB 默认 |
| Table 2 | 256QAM | 948/1024 | 7.41 bps/Hz | 高 SINR |
| Table 3 | 64QAM | 948/1024 | 5.55 bps/Hz | URLLC (BLER=1e-5) |

---

## 6. NR MIMO 传输模式

NR 未沿用 LTE 的固定 TM 编号，但功能对等机制如下：

| NR 对应机制 | LTE TM | 描述 | DCI 格式 | 关键特征 |
|:----------|:------|:----|:--------|:--------|
| 单端口传输 | **TM1** | 单天线 (SISO) | DCI 1_0 | 仅 1 层, 1 天线端口 |
| 发射分集 | **TM2** | SFBC (2 端口) 或 FSTD (4 端口) | DCI 1_0 (fallback) | 鲁棒传输, 无 CSI 反馈 |
| 开环 MIMO | **TM3** | 大延迟 CDD + 预编码循环 | DCI 0_1/1_1 (OL) | 高速移动, 仅 CQI/RI 反馈 |
| 闭环 MIMO | **TM4** | 基于 PMI 的预编码 | DCI 0_1/1_1 (CL) | 静态/低速, 全 CSI 反馈 |

### 6.1 TM1: 单端口传输

```
发射:
  数据 → 调制 → 层映射 (单层) → 天线端口 → OFDM

特点:
  - 无空间复用增益
  - 无 CSI 反馈开销
  - 广播/控制信道, 或低 SINR 回退
```

### 6.2 TM2: 发射分集 (SFBC)

**2 天线端口 SFBC** (Space-Frequency Block Code, Alamouti 扩展)：

| 子载波 | 天线端口 0 | 天线端口 1 |
|:-----:|:---------:|:---------:|
| $k$ | $x_0$ | $x_1$ |
| $k+1$ | $-x_1^*$ | $x_0^*$ |

分集增益: 2 (N_t 阶)。无速率损失 (全速率码)。

**4 天线端口**: SFBC + FSTD (Frequency Switched Transmit Diversity) 组合。

### 6.3 TM3: 开环 MIMO (大延迟 CDD)

```
数据层 → 预编码矩阵 W(i) (按 RE/PRB 循环) → 天线端口

预编码循环:
  W(i) = D(i) · U
  D(i) = diag(1, e^{-j2πi/2}, ..., e^{-j2πi(N_layer-1)/N_layer})
  U: 固定 DFT 矩阵 (层 × 层)
```

**特性**: 不需要 PMI 反馈，仅需 RI + CQI。适合高速移动 ($v > 30$ km/h)，CSI 反馈过时。

### 6.4 TM4: 闭环 MIMO (基于 PMI)

```
             ┌──────────────────┐
   UE:       │ CSI-RS 测量       │
             │ PMI/CQI/RI 反馈   │
             └────────┬─────────┘
                      │
             ┌────────▼─────────┐
   gNB:      │ 查码本, 选预编码  │
             │ 调度 + 预编码     │
             │ 发送预编码 PDSCH  │
             └──────────────────┘
```

**适用**: 静态/低速 ($v < 10$ km/h), 需要精确 CSI。

---

## 7. MU-MIMO 调度

### 7.1 配对准则

MU-MIMO 的核心挑战：选择空间域正交性好的用户配对。

**信道正交性度量**:

$$\rho_{ij} = \frac{|\langle h_i, h_j \rangle|}{\|h_i\| \cdot \|h_j\|}$$

其中 $h_i$, $h_j$ 为用户 $i$ 和 $j$ 的信道向量。

| $|\rho_{ij}|$ | 正交性 | MU-MIMO 可行性 |
|:------------:|:------:|:-------------:|
| < 0.2 | 优秀 | 高谱效, 干扰可忽略 |
| 0.2 ~ 0.5 | 中等 | 需 IRC 接收机 |
| > 0.5 | 差 | MU-MIMO 增益有限, 建议 SU-MIMO |
| > 0.8 | 极差 | 接近共线, 无法空间分离 |

**配对算法流程**:

```
1. 候选集: 所有有数据的 UE
2. 选择信道增益最大的 UE 作为第一个配对用户
3. 逐个添加用户:
   - 计算与已选用户的正交性
   - 评估添加后的总吞吐量
   - 若总吞吐量提升 → 接受
   - 否则跳过
4. 循环至达到最大配对用户数 (4~12) 或无增益
```

### 7.2 功率分配

MU-MIMO 配对用户间合理分配发射功率。

**等功率分配** (简单):

$$P_k = \frac{P_{total}}{K}, \quad k = 1, 2, \dots, K$$

**注水功率分配** (最优):

$$P_k = \max\left(0, \mu - \frac{\sigma^2}{\lambda_k^2}\right)$$

其中 $\lambda_k$ 为等效信道 $H_{eff}$ 的奇异值，$\mu$ 为水位 (满足总功率约束)。

**下行功率分配策略**:

| 策略 | 复杂度 | 公平性 | 小区总吞吐量 |
|:----|:------:|:-----:|:----------:|
| 等功率 | 低 | 低 (偏向好信道 UE) | 中 |
| 注水法 | 中 | 低 (最大化总和速率) | 高 |
| 比例公平 | 高 | 高 | 中高 |
| Max-Min | 高 | 最高 | 低 |

### 7.3 R16/R17 MU-MIMO 增强

#### 非相干联合传输 (NCJT, R16)

```
多 TRP 同时服务一个 UE，各自独立预编码:

        ┌──────┐       ┌──────┐
        │ TRP1 │       │ TRP2 │
        └──┬───┘       └──┬───┘
           │  H1          │  H2
           └──────┬───────┘
                  ▼
               ┌─────┐
               │ UE  │
               └─────┘

接收: y = H1·W1·s1 + H2·W2·s2 + n

非相干: s1 ≠ s2 (可能不同层/不同 TB)
相干: s1 = s2 (相同发送, 需 TRP 间相位同步 — R17 研究)
```

#### 多 TRP 增强 (R17)

| 增强 | 描述 | 增益 |
|:----|:----|:----|
| **S-DCI mTRP** | 单 DCI 调度多 TRP | 控制信道开销低 |
| **M-DCI mTRP** | 每 TRP 独立 DCI | 调度灵活 |
| **CJT (相干联合传输)** | TRP 间相位同步, 同相叠加 | 阵列增益 (研究阶段) |
| **FDM/SDM 复用** | 不同 TRP 占不同频域/空域资源 | 干扰规避 |

#### R18 展望

- **AI/ML 信道预测**: 基于历史 CSI 预测未来信道，克服反馈延迟
- **增强 NCJT**: 支持 4 TRP 联合传输
- **分布式 MIMO**: 大量分布式天线头 (Radio Stripe 架构)

---

## 附录 A: 关键矩阵运算总结

| 运算 | 公式 | 复杂度 | 用途 |
|:----|:----|:------|:----|
| ZF 检测 | $(H^H H)^{-1} H^H$ | $O(N_r N_t^2 + N_t^3)$ | 干扰消除 |
| MMSE 检测 | $(H^H H + \sigma^2 I)^{-1} H^H$ | $O(N_r N_t^2 + N_t^3)$ | 噪声鲁棒检测 |
| LMMSE-IRC | $H^H (H H^H + R)^{-1}$ | $O(N_r N_t^2 + N_r^3)$ | 有色干扰抑制 |
| SVD 预编码 | $H = U \Sigma V^H,\ W = V_{1:k}$ | $O(\min(N_r, N_t) N_r N_t)$ | 最优预编码 |
| ZF 预编码 | $H^H (H H^H)^{-1}$ | $O(N_r N_t^2 + N_r^3)$ | MU-MIMO 干扰归零 |
| QR 分解 (球形译码) | $H = QR$ | $O(N_r N_t^2)$ | 树搜索预处理 |

## 附录 B: 缩略词

| 缩略词 | 全称 | 中文 |
|:------|:----|:----|
| CDL | Clustered Delay Line | 簇延迟线模型 |
| CDM | Code Division Multiplexing | 码分复用 |
| CJT | Coherent Joint Transmission | 相干联合传输 |
| CQI | Channel Quality Indicator | 信道质量指示 |
| CRI | CSI-RS Resource Indicator | CSI-RS 资源指示 |
| CSI | Channel State Information | 信道状态信息 |
| CSI-IM | CSI Interference Measurement | CSI 干扰测量 |
| DCI | Downlink Control Information | 下行控制信息 |
| DMRS | Demodulation Reference Signal | 解调参考信号 |
| FD-MIMO | Full-Dimension MIMO | 全维度 MIMO |
| FSTD | Frequency Switched Transmit Diversity | 频率切换发射分集 |
| IRC | Interference Rejection Combining | 干扰抑制合并 |
| LI | Layer Indicator | 层指示 |
| MLD | Maximum Likelihood Detection | 最大似然检测 |
| MMSE | Minimum Mean Square Error | 最小均方误差 |
| NCJT | Non-Coherent Joint Transmission | 非相干联合传输 |
| NZP | Non-Zero-Power | 非零功率 |
| PMI | Precoding Matrix Indicator | 预编码矩阵指示 |
| RI | Rank Indicator | 秩指示 |
| SD | Sphere Decoder | 球形译码 |
| SFBC | Space-Frequency Block Code | 空频分组码 |
| SRS | Sounding Reference Signal | 探测参考信号 |
| TDL | Tapped Delay Line | 抽头延迟线模型 |
| TRP | Transmission Reception Point | 收发点 |
| ZF | Zero-Forcing | 迫零 |

## 附录 C: 参数速查

| 参数 | 取值/范围 | 3GPP 引用 |
|:----|:--------|:---------|
| DL 最大层数 | 16 (R15), 更高在研究 | TS 38.214 §5.1 |
| UL 最大层数 | 8 | TS 38.214 §6.1 |
| DMRS Type 1 最大端口 | 16 (双符号) | TS 38.211 §7.4.1.1 |
| DMRS Type 2 最大端口 | 24 (双符号) | TS 38.211 §7.4.1.1 |
| CSI 子带大小 | 4/8/16 PRB (取决于 BWP) | TS 38.214 §5.2.1.4 |
| Type II 码本 L 值 | 2, 3, 4 | TS 38.214 §5.2.2.2.5 |
| eType II 频域基 M | 1~18 (RRC 配置) | TS 38.214 §5.2.2.2.5 |
| CQI 表 | Table 1/2/3 | TS 38.214 §5.2.2.1 |
| CDL 模型 | CDL-A/B/C/D/E | TR 38.901 §7.7.1 |
| NCJT 最大 TRP 数 | 2 (R16) | TS 38.214 §5.1 |
