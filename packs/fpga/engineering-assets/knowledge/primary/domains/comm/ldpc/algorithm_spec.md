---
name: ldpc-encoding-spec
algorithm: "LDPC Codec"
version: "1.0"
status: "draft"
tags: [comm, ldpc, channel-coding, qc-ldpc, wifi]
---

# LDPC 信道编解码 算法规格书

## 1. 概述

### 1.1 应用场景

LDPC (Low-Density Parity-Check) 码是 OFDM 通信系统中前向纠错 (FEC) 的核心模块。
在本 OFDM 链路中位置：

```
TX: 信源 → LDPC编码 → 交织 → QAM调制 → OFDM调制 → ...
RX: ... → OFDM解调 → 信道均衡 → QAM解调 → 解交织 → LDPC译码 → 信宿
```

### 1.2 802.11n QC-LDPC 码参数

采用 IEEE 802.11n/ac 标准的 QC-LDPC (Quasi-Cyclic LDPC) 码：

| 参数 | 值 | 说明 |
|:----:|:--:|:----|
| 码块长度 N | 648 bit | 短块，适合 802.11a/n 场景 |
| 信息位长度 K | 324 bit | R=1/2 编码 |
| 校验位长度 M | 324 bit | N-K |
| 码率 R | 1/2 | 基础码率 |
| 子块大小 Z | 27 | 提升因子 (lifting factor) |
| 校验矩阵 | H (M×N) | 324×648 稀疏矩阵 |
| 列重 | 3 | 每列 3 个非零元素 |
| 行重 | 6 | 每行 6 个非零元素 |

> **设计选择**: 以 802.11n R=1/2, N=648 为基础，兼顾性能与硬件复杂度。
> 后续可扩展至 R=2/3, 3/4, 5/6 (同标准族)。

---

## 2. 算法与数学原理

### 2.1 QC-LDPC 校验矩阵结构

QC-LDPC 的 H 矩阵由循环排列子矩阵 (circulant permutation matrices) 构成：

```
      ┌──────────────────────────────────┐
      │  I(P₁₁)  I(P₁₂)  ...  I(P₁,NC)  │ ← mb 块行
H =   │  I(P₂₁)  I(P₂₂)  ...  I(P₂,NC)  │
      │  ...      ...      ...   ...     │
      │  I(Pmb₁) I(Pmb₂) ...  I(Pmb,NC) │
      └──────────────────────────────────┘
                         ↑ nb 块列
```

每个子矩阵是 Z×Z 的循环右移单位阵或零矩阵，
`I(P)` 表示单位阵循环右移 P 位。

对于 802.11n R=1/2, N=648:
- mb = 12 (12 块行 × 27 = 324 校验行)
- nb = 24 (24 块列 × 27 = 648 码块长)
- 每个非零条目 P(i,j) ∈ {-1, 0, ..., Z-1}, -1 表示零矩阵

### 2.2 LDPC 编码

**直接编码 (Generator Matrix 法)**:

由 H·cᵀ = 0，通过高斯消元得生成矩阵 G：

```
c = u · G = [u | p]
```

其中 u 为信息位，p 为校验位。

**802.11n 高效编码 (Back-Substitution)**:

利用 H 的近似下三角结构 (Approximate Lower Triangular, ALT)：

```
H = ┌───┬─────┐
    │ A │  B  │  T  ← 零三角
    ├───┼─────┤
    │ C │  D  │  E
    └───┴─────┘
```

编码步骤（参见 IEEE 802.11n 标准 20.3.11.6）：

1. 计算 λ = -E·T⁻¹·A + C 的乘积
2. 校验位 p₁ = λ·(E·T⁻¹·B + D)⁻¹·(信息位向量)
3. 校验位 p₂ = -T⁻¹·(A·信息位 + B·p₁)

**移位寄存器编码器 (硬件友好)**:

对 QC-LDPC，每个块列可用 Z-bit 循环移位加累加器实现：

```
for i = 1 to nb
    for j = 1 to mb
        if H(i,j) ≠ -1
            acc[j] = acc[j] ⊕ shift(信息块_i, P(i,j))
```

### 2.3 LDPC 译码 — 置信传播 (BP)

**因子图模型**：

```
变量节点 (VN)          校验节点 (CN)
    ○───○───○───○       ○───○───○
    │   │   │   │       │   │   │
    │   │   │   │       │   │   │
    ○───○───○───○       ○───○───○
   N个变量节点          M个校验节点
```

每条边连接一个 VN 和一个 CN，对应 H 矩阵的非零元。

**对数似然比 (LLR)**：

$$L(c_i) = \log \frac{P(c_i=0|y_i)}{P(c_i=1|y_i)}$$

对于 BPSK 调制 (s_i = 1-2c_i)，AWGN 信道：
$$L(c_i) = \frac{2y_i}{\sigma^2}$$

**Sum-Product 算法 (SPA)**：

1. **初始化**: VN→CN 消息 = 信道 LLR

2. **CN 更新 (水平步)**:
   $$L_{j\to i} = 2 \tanh^{-1}\left( \prod_{i' \in N(j)\setminus i} \tanh\left(\frac{L_{i'\to j}}{2}\right) \right)$$
   硬件简化: 最小和近似
   $$L_{j\to i} \approx \alpha \cdot \prod_{i'} \text{sign}(L_{i'\to j}) \cdot \min_{i'} |L_{i'\to j}|$$
   α 为缩放因子 (0.75~0.875)

3. **VN 更新 (垂直步)**:
   $$L_{i\to j} = L_{ch,i} + \sum_{j' \in M(i)\setminus j} L_{j'\to i}$$

4. **硬判决**:
   $$L_i^{total} = L_{ch,i} + \sum_{j \in M(i)} L_{j\to i}$$
   $$\hat{c}_i = \begin{cases} 0, & L_i^{total} \geq 0 \\ 1, & L_i^{total} < 0 \end{cases}$$

5. **停止条件**: H·ĉ = 0 或达到最大迭代次数

### 2.4 分层译码 (Layered Decoding)

将 H 矩阵按行分成若干层（每层为非重叠的 CN 集合），
逐层更新，每层内并行处理：

```
for iter = 1 to MAX_ITER
    for layer = 1 to NUM_LAYERS
        // 读取当前层所有 VN 的旧消息
        // CN 更新 (并行，层内无冲突)
        // VN 更新 + 写入新消息
    end
end
```

**优势**:
- 收敛速度约 2× (同性能下迭代次数减半)
- 存储需求减半 (只需存储后验 LLR，不需 VN→CN 消息矩阵)

---

## 3. 接口定义

### 3.1 编码器接口

| 信号 | 位宽 | 方向 | 说明 |
|:----|:---:|:----|:----|
| clk | 1 | I | 系统时钟 |
| rst_n | 1 | I | 异步复位 (低有效) |
| s_axis_info_tdata | K | I | 信息位输入 (324 bit) |
| s_axis_info_tvalid | 1 | I | 信息位有效 |
| s_axis_info_tlast | 1 | I | 块结束标志 |
| m_axis_code_tdata | N | O | 编码输出 (648 bit) |
| m_axis_code_tvalid | 1 | O | 编码输出有效 |
| m_axis_code_tlast | 1 | O | 块结束标志 |

### 3.2 译码器接口

| 信号 | 位宽 | 方向 | 说明 |
|:----|:---:|:----|:----|
| clk | 1 | I | 系统时钟 |
| rst_n | 1 | I | 异步复位 |
| s_axis_llr_tdata | N×Q | I | LLR 输入 (648×Q bit) |
| s_axis_llr_tvalid | 1 | I | LLR 有效 |
| s_axis_llr_tlast | 1 | I | 块结束 |
| m_axis_data_tdata | K | O | 译码输出 (324 bit) |
| m_axis_data_tvalid | 1 | O | 输出有效 |
| m_axis_data_tlast | 1 | O | 块结束 |
| m_axis_iter_tdata | 8 | O | 实际迭代次数 |

---

## 4. 性能目标

| 指标 | 目标 | 条件 |
|:----|:---:|:----|
| 编码增益 | ≥ 6 dB | BER=10⁻⁵, BPSK, AWGN |
| 收敛迭代 | < 15 次 | 分层译码 |
| 吞吐率 | ≥ 100 Mbps | FPGA @ 200 MHz |
| 资源 | < 10 BRAM | 单译码核 |

---

## 5. 参考资料

1. IEEE 802.11n-2009, Section 20.3.11.6 "LDPC encoding"
2. IEEE 802.11ac-2013, Section 22.3.8 "LDPC encoding"
3. Gallager, "Low-Density Parity-Check Codes", 1963
4. D. E. Hocevar, "A reduced complexity decoder architecture for LDPC codes", 2004
5. 白薇, "5G通信系统中LDPC编译码器的设计与实现", 西安电子科技大学
6. MATLAB Communications Toolbox — `ldpcEncode`, `ldpcDecode`, `dvbs2ldpc`
