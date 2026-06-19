---
name: algorithm-spec
algorithm: "OFDM Synchronization"
version: "1.0"
status: "draft"
tags: [comm, ofdm, synchronization, timing, cfo]
---

# OFDM 同步 (Synchronization) 算法规格书

## 1. 概述

### 1.1 同步问题

OFDM 接收机对时间和频率偏移高度敏感：

| 失步类型 | 影响 | 容忍度 |
|:--------:|:----|:------:|
| 符号定时偏移 | ISI + 相位旋转 | < CP 长度 (16 样点) |
| 载波频偏 (CFO) | 子载波间干扰 (ICI) | < 子载波间隔的 2% |

### 1.2 前导码结构 (802.11a)

```
┌─── Short Preamble ───┐┌─── Long Preamble ───┐┌── Signal ─┐
t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 GI2 T1 T2  GI  SIGNAL
├── 10 × 16 ──┤  ├── 2 × 64 ──┤
├────── 160 ──────────┤├── 64+64 ───┤├── 80 ──┤
```

| 字段 | 长度 (样点) | 用途 |
|:----:|:-----------:|------|
| t1-t10 | 160 (10×16) | 包检测、粗定时、粗 CFO、AGC |
| GI2 | 32 | 长前导码 CP (2×常规长度) |
| T1, T2 | 128 (2×64) | 精定时、精 CFO、信道估计 |
| SIGNAL | 80 (64+16CP) | 信令字段 (速率+长度) |

### 1.3 接收信号模型

$$r[n] = s[n - \tau] \cdot e^{j2\pi \epsilon n / N} + w[n]$$

其中 $\tau$ 为定时偏移，$\epsilon = \Delta f / \Delta f_{sc}$ 为归一化 CFO，$w[n]$ 为 AWGN。

---

## 2. 算法与数学原理

### 2.1 包检测 (粗定时)

**原理**: 短前导码的周期自相关 (周期 16 样点)

$$C[n] = \sum_{k=0}^{L-1} r[n+k] \cdot r^*[n+k+N_{short}]$$
$$P[n] = \sum_{k=0}^{L-1} |r[n+k+N_{short}]|^2$$
$$M[n] = \frac{|C[n]|^2}{P[n]^2}, \quad N_{short}=16, L=16$$

**判决**: $M[n] > \eta_{detect}$ 持续 $\geq$ 8 个样点 → 包到达

### 2.2 粗 CFO 估计

利用短前导码的相位旋转：

$$\hat{\epsilon}_{coarse} = \frac{N}{2\pi N_{short}} \cdot \angle\left(\sum_{k=0}^{L-1} r[n_{peak}+k] \cdot r^*[n_{peak}+k+N_{short}]\right)$$

**估计范围**: $|\epsilon| \leq N/(2 N_{short}) = 64/32 = 2$ (即 ±2 子载波间隔)

**方法**: 取多个相关值的平均角度

### 2.3 CFO 补偿

$$r_{corr}[n] = r[n] \cdot e^{-j2\pi \hat{\epsilon} n / N}$$

实现: CORDIC 旋转或查表法

### 2.4 精定时 (长前导码边界)

**原理**: 长前导码 T1 已知，用滑动互相关找峰值

$$R[n] = \sum_{k=0}^{N-1} r[n+k] \cdot t_{T1}^*[k]$$
$$\hat{n}_{opt} = \arg\max_n |R[n]|^2$$

**精度**: 定位到单个样点，配合 CP 保护可无 ISI

### 2.5 精 CFO 估计

利用 T1 和 T2 的相位差 (间距 64 样点)：

$$\hat{\epsilon}_{fine} = \frac{1}{2\pi} \cdot \angle\left(\sum_{k=0}^{N-1} r_{T1}^*[k] \cdot r_{T2}[k]\right)$$

**估计范围**: $|\epsilon| \leq 0.5$ (半个子载波间隔)

> 精 CFO 与粗 CFO 组成级联估计，总范围 ±2，精度 $\ll$ 1%

---

## 3. 信号流与模块划分

```
r[n] (ADC 输入)
  │
  ▼
┌──────────────────┐
│  包检测 (粗定时)  │ ← 周期自相关 M[n] > η
│  Packet Detect    │ → 帧起始标志
└────────┬─────────┘
         ▼
┌──────────────────┐
│  粗 CFO 估计      │ ← 短前导码相位
│  Coarse CFO Est  │ → ε_coarse
└────────┬─────────┘
         ▼
┌──────────────────┐
│  CFO 补偿         │ ← r_corr[n] = r[n] × e^{-j2πεn/N}
│  CFO Correction  │
└────────┬─────────┘
         ▼
┌──────────────────┐
│  精定时           │ ← 长前导码互相关
│  Fine Timing     │ → FFT 窗口起始
└────────┬─────────┘
         ▼
┌──────────────────┐
│  精 CFO 估计      │ ← T1/T2 相位差
│  Fine CFO Est    │ → ε_fine (级联校正)
└────────┬─────────┘
         ▼
     [去 CP → FFT → 信道估计 → 均衡]
```

---

## 4. 关键变量

| 符号 | 含义 | 值 |
|:----:|:----|:---:|
| $N$ | FFT 点数 | 64 |
| $N_{CP}$ | CP 长度 | 16 |
| $N_{short}$ | 短前导码周期 | 16 |
| $L_{corr}$ | 自相关窗长 | 16 |
| $\eta_{detect}$ | 包检测门限 | 0.5 |
| $N_{long}$ | 长前导码长度 | 64 |
| $f_s$ | 采样率 | 20 MHz |
| $\Delta f$ | 子载波间隔 | 312.5 kHz |
| CFO 估计范围 (粗) | $\pm 2 \Delta f$ | ±625 kHz |
| CFO 估计范围 (精) | $\pm 0.5 \Delta f$ | ±156.25 kHz |

---

## 5. 定点格式规划

| 信号 | 格式 | 位宽 | 说明 |
|:----:|:----:|:----:|------|
| r[n] (ADC) | Q2.14 | 16-bit | AXI4-Stream 输入 |
| 自相关 C[n] | Q2.30 | 32-bit | 复数 MAC 累积 |
| 功率 P[n] | Q4.28 | 32-bit | 幅值平方累积 |
| 判决 M[n] | Q1.15 | 16-bit | 归一化后 |
| CFO (粗/精) | Q0.15 | 16-bit | 归一化频率 (相位角) |
| 旋转因子 | Q1.15 | 16-bit | CORDIC 常量 |

---

## 6. 验收标准

| 指标 | 目标 | 说明 |
|:----:|:----:|------|
| 包检测概率 | > 99% @ SNR ≥ 10 dB | AWGN 信道 |
| 虚警概率 | < 1% | 仅噪声时 |
| 粗定时精度 | ±8 样点 | 落在 CP 范围内即可 |
| 精定时精度 | ±1 样点 | 单样点级精度 |
| 粗 CFO 误差 | < 5% 残差 | SNR ≥ 10 dB |
| 精 CFO 误差 | < 0.5% 残差 | SNR ≥ 10 dB |
| 资源 | < 5% LUT/DSP | XC7K325T |
| 延迟 | < 320 样点 (16 μs) | 一个短前导码窗口 |
