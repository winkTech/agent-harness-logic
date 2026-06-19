---
name: ofdm-algorithm-spec
algorithm: "OFDM"
version: "1.0"
status: "draft"
tags: [comm, ofdm, multicarrier, fft]
---

# OFDM 发射机 算法规格书

## 1. 数学原理

### 1.1 OFDM 基本原理

OFDM (Orthogonal Frequency Division Multiplexing) 将高速串行数据流分解为 N 个并行的低速子载波，每个子载波用相互正交的子信道传输。

**发射端:**

$$
x(t) = \sum_{k=0}^{N-1} X_k \cdot e^{j2\pi k \Delta f t}, \quad 0 \leq t < T
$$

其中 $X_k$ 为第 k 个子载波上的调制符号，$\Delta f = 1/T$ 为子载波间隔，$T$ 为 OFDM 符号周期。

**离散实现 (IFFT):**

$$
x[n] = \frac{1}{\sqrt{N}} \sum_{k=0}^{N-1} X_k \cdot e^{j2\pi kn/N}, \quad n = 0,...,N-1
$$

**接收端 (FFT):**

$$
Y_k = \frac{1}{\sqrt{N}} \sum_{n=0}^{N-1} y[n] \cdot e^{-j2\pi kn/N}
$$

### 1.2 信号流图

```
发射机:
BitStream ──→ [调制映射] ──→ [导频插入] ──→ [IFFT] ──→ [加CP] ──→ [成形滤波] ──→ DAC

接收机:
ADC ──→ [去CP] ──→ [FFT] ──→ [信道估计] ──→ [均衡] ──→ [解调] ──→ BitStream
                   ↑             ↑
               [同步] ────────┘
```

### 1.3 关键变量定义

| 符号 | 含义 | 典型值 |
|------|------|--------|
| $N$ | FFT 点数 | 64/256/1024/2048 |
| $N_{CP}$ | 循环前缀长度 | N/4 (16/64/256/512) |
| $N_{data}$ | 数据子载波数 | 52(20MHz WiFi) / 1200(20MHz LTE) |
| $N_{pilot}$ | 导频子载波数 | 4(WiFi) / 特定位置(LTE) |
| $\Delta f$ | 子载波间隔 | 15kHz(LTE) / 312.5kHz(WiFi) |
| $T_{sym}$ | OFDM 符号周期 | $(N+N_{CP})/f_s$ |

---

## 2. 参数分析

### 2.1 系统参数 (以 802.11a 为参考)

| 参数 | 值 |
|------|----|
| FFT 点数 N | 64 |
| 数据子载波 | 48 |
| 导频子载波 | 4 |
| 空子载波(DC+Guard) | 12 |
| CP 长度 | 16 (1/4) |
| 采样率 | 20MHz |
| 子载波间隔 | 312.5kHz |
| OFDM 符号周期 | 4μs (3.2μs + 0.8μs) |
| 调制方式 | BPSK/QPSK/16QAM/64QAM |
| 编码率 | 1/2, 2/3, 3/4 |

### 2.2 FFT 参数需求

| 参数 | 值 | 说明 |
|------|----|------|
| FFT 类型 | 基-4 / 基-2 | 流式或突发 |
| 变换方向 | IFFT/FFT | 共用核 |
| 缩放策略 | 块浮点 / 逐级缩 | 防止溢出 |
| 延迟要求 | < N 时钟周期 | |

---

## 3. 设计约束

### 3.1 目标器件

| 器件系列 | DSP48 | BRAM | 适用场景 |
|----------|-------|------|----------|
| XC7K325T | 840 | 445 | 中端/通用 |
| XCZU9EG | 2520 | 912 | RFSoC/高速 |
| XC7Z020 | 220 | 140 | 入门/Zynq |

### 3.2 接口协议

| 接口 | 方向 | 协议 |
|------|------|------|
| 数据输入 | Slave | AXI4-Stream |
| 数据输出 | Master | AXI4-Stream |
| 配置 | Slave | AXI4-Lite |

### 3.3 时序约束

| 时钟域 | 频率 | 说明 |
|--------|------|------|
| clk | ≥ 采样率×2 | 过采样处理 |
| axi_clk | 同 clk 或更高 | 配置接口 |

---

## 4. 子模块划分

| 模块 | 功能 | 关键参数 |
|------|------|----------|
| **mod_mapper** | PSK/QAM 调制映射 | QPSK/16QAM/64QAM |
| **pilot_insert** | 导频/DC/Guard 插入 | 位置可配置 |
| **fft_core** | IFFT/FFT 变换 | N=64~2048 |
| **cp_insert** | 循环前缀添加 | CP_LEN 可配 |
| **filter** | 成形滤波(可选) | RRC/FIR |

---

## 5. 验收标准

| 指标 | 目标 | 测试方法 |
|------|------|----------|
| EVM | < -25dB @ 64QAM | MATLAB → RTL 逐比特比对 |
| 吞吐 | 1 sample/clock | AXI4-Stream 连续模式 |
| 延迟 | < N×2 clk | IFFT 输入到输出 |
| 资源 | < 10% DSP48(XC7K325T) | Vivado 综合报告 |
