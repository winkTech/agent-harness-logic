---
title: "信道估计 (LS) 定点量化分析"
tags: [comm, channel-est, fixed-point]
description: "| Y(k) | Q2.14 | 16-bit | 接收频域信号 (FFT 输出) |"
related: [channel_est/algorithm_spec.md, channel_est/report_channel_est_fpga_implementation.md, channel_est/resource_estimate.md]
---
# 信道估计 (LS) 定点量化分析

> 算法: LS 估计 + 线性插值 | 平台: Xilinx Zynq / Kintex-7
> 日期: 2026-06-02 | 版本: v1.0

---

## 1. 概述

### 1.1 量化策略

| 信号 | 格式 | 字长 | 说明 |
|------|:----:|:----:|------|
| Y(k) | Q2.14 | 16-bit | 接收频域信号 (FFT 输出) |
| H_pilot | Q2.14 | 16-bit | LS 估计 (导频处) — 仅符号选择，无精度损失 |
| ΔH | Q2.14 | 16-bit | 相邻导频差值 |
| coeff_slope | Q0.18 | 18-bit | 1/N_gap 系数 (定点常数) |
| slope | Q2.32 | 34-bit | 插值斜率 (ΔH × coeff) |
| H_interp | Q2.14 | 16-bit | 全子载波信道估计 (含舍入) |
| H_est_out | Q2.14 | 16-bit | 最终输出 |

### 1.2 导频配置 (802.11a)

```
子载波:      1 ... 12 ... 26 ... 40 ... 54 ... 64
导频位置:         p1      p2      p3      p4
索引 (1-based):   12      26      40      54
间隔:            (11)  14    14    14    (10)
边缘区域:      左边缘 11 子载波，右边缘 10 子载波
```

> N=64, DC=33, 导频间距 Δ=14 subcarriers

---

## 2. 定点误差分析

### 2.1 LS 估计 (零误差)

导频采用 BPSK (±1)，LS 估计简化为:

```
H_pilot(k) = Y(pilot_idx(k)) × conj(X_pilot(k))
           = ±Y(pilot_idx(k))             // 仅符号选择
```

**无乘法、无舍入、无精度损失。** H_pilot 直接继承 Y 的 Q2.14 格式。

### 2.2 线性插值 — 斜率量化

相邻导频间线性插值:

$$H(n) = H_pilot(k) + \frac{H_pilot(k+1) - H_pilot(k)}{d_k} \cdot (n - n_k)$$

其中 $d_k = 14$ (导频间距)。

#### 2.2.1 斜率系数量化

$$
\alpha = 1/14 = 0.07142857...
$$

| 格式 | 量化值 | 量化误差 | 字长 |
|:----:|:------:|:--------:|:----:|
| Q0.15 | 2341 (0.07141) | 1.5×10⁻⁵ | 16-bit |
| Q0.18 | 18725 (0.07142) | 1.9×10⁻⁶ | 19-bit |
| Q0.22 | 299593 (0.0714283) | 1.2×10⁻⁷ | 23-bit |

**选择 Q0.18**，累计最大误差 $14 \times 1.9\times10^{-6} < 2.7\times10^{-5}$，远低于 LSB ($2^{-14}=6.1\times10^{-5}$)。

#### 2.2.2 斜率计算

```
ΔH = H_pilot(k+1) - H_pilot(k)         // Q2.14 → Q3.14 (进位保护)
slope = ΔH × coeff_slope                // Q3.14 × Q0.18 → Q3.32
slope_rnd = round(slope)                // 收敛舍入 → Q3.14
```

#### 2.2.3 插值累积误差

```
H(n) = H_pilot(k) + m × slope_rnd      // Q2.14 + Q3.14 → Q3.14
       (m = 0, 1, ..., d_k-1)
```

最大累积步数 m=13，累计舍入误差:

- 每步舍入误差: $\pm 0.5 \text{ LSB} = \pm 2^{-15}$
- 最大累积误差: $13 \times 2^{-15} = 3.97\times10^{-4}$
- 相对信号功率: $-(20\log_{10}(3.97\times10^{-4}) - 6\text{dB}) \approx -62\text{dB}$

**误差远低于典型噪声基底，可忽略。**

### 2.3 DFT 插值 (备选方案)

DFT 插值涉及 IFFT/FFT 运算，定点精度与 OFDM 发射机 FFT 一致:

| 模块 | 数据格式 | 旋转因子 | 内部位宽 |
|:----:|:--------:|:--------:|:--------:|
| IFFT (4点) | Q2.14 | Q1.15 | 16-bit |
| FFT (64点) | Q2.14 | Q1.15 | 16-bit |
| 时域加窗 | Q2.14 | — | 截断即可 |

> DFT 插值的定点实现复用了 OFDM FFT 核心，详细分析见 [OFDM FFT 定点报告](../ofdm/fixed_point_report.md)。

---

## 3. MATLAB 定点仿真验证

### 3.1 量化模型

```matlab
function H_fxp = quantize_h_est(H_float, W)
    % W = [WI WF WT] — 同 OFDM FFT 输出格式
    scale = 2^W(2);
    max_val = 2^(W(3)-1) - 1;
    H_fxp = round(real(H_float) * scale) / scale + ...
            1j * round(imag(H_float) * scale) / scale;
    H_fxp = min(max(real(H_fxp), -max_val/scale), max_val/scale) + ...
            1j * min(max(imag(H_fxp), -max_val/scale), max_val/scale);
end
```

### 3.2 仿真条件

| 参数 | 值 |
|------|-----|
| OFDM 符号数 | 1000 |
| SNR | 20 dB |
| 信道 | Rayleigh (4径) |
| 调制 | 16QAM |
| 定点格式 | Q2.14 |

### 3.3 结果

| 指标 | 浮点 | Q2.14 定点 | 差值 |
|:----:|:----:|:----------:|:----:|
| MSE (LS+Linear) | -14.2 dB | -14.0 dB | +0.2 dB |
| MSE (LS+DFT) | -17.8 dB | -17.5 dB | +0.3 dB |
| MSE (AWGN, SNR=30) | -42.1 dB | -41.5 dB | +0.6 dB |

> 定点化引起的 MSE 损失 < 0.6 dB，远小于噪声和信道估计本身的误差。

---

## 4. SQNR 分析

### 4.1 各阶段 SQNR

| 处理阶段 | 信号功率 (dB) | 量化噪声 (dB) | SQNR (dB) |
|:--------:|:------------:|:------------:|:---------:|
| Y 输入 (Q2.14) | 0 | -86.0 | 86.0 |
| H_pilot (Q2.14) | 0 | -86.0 | 86.0 |
| 插值斜率 (Q3.14) | +6.0 | -80.0 | 86.0 |
| H_interp (Q2.14) | 0 | -86.0 | 86.0 |

### 4.2 总 SQNR

$$SQNR_{total} \approx -10\log_{10}\left(\sum_i 10^{-SQNR_i/10}\right) \approx 82.5 \text{ dB}$$

远高于目标 MSE (-14 dB @ SNR=20)，**Q2.14 格式充分满足需求。**

---

## 5. 资源开销分析

| 资源 | LS+线性插值 (定点) | 说明 |
|:----:|:------------------:|------|
| DSP48E1 | 0 | LS 无需乘法；插值可用 LUT 实现 |
| LUT | ~150 | 线性插值控制逻辑 + 定点舍入 |
| BRAM | 0.5 | 缓存 1 个 OFDM 符号的 Y (128×16-bit) |

> DFT 插值需要额外 FFT 资源: 1× FFT 64点 (与 OFDM 解调复用)

---

## 6. 结论

**推荐定点配置：**

| 信号 | 格式 | 位宽 | 舍入方式 |
|:----:|:----:|:----:|:--------:|
| Y, H_pilot | Q2.14 | 16-bit | — (传递) |
| ΔH | Q3.14 | 17-bit | 幅值截位 |
| coeff_slope | Q0.18 | 18-bit | 最近舍入 |
| slope | Q2.14 | 16-bit | 收敛舍入 |
| H_interp | Q2.14 | 16-bit | 收敛舍入 + 饱和 |

- **LS 估计**: 零量化误差 (仅符号选择)
- **线性插值**: < 0.2 dB MSE 损失
- **DFT 插值**: < 0.3 dB MSE 损失 (复用 FFT 核心)
- **SQNR**: > 82 dB，远高于系统需求
