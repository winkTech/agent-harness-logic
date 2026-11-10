---
name: report-channel-est-fpga-implementation
title: "信道估计 (LS) FPGA 实现报告"
tags: [comm, channel-est, impl]
description: "1. **LS 估计**: $H_{pilot}(k) = Y_{pilot}(k) \cdot X^*_{pilot}(k)$"
related: [channel_est/algorithm_spec.md, channel_est/fixed_point_report.md, channel_est/resource_estimate.md]
---
# 信道估计 (LS) FPGA 实现报告

> 算法: LS 估计 + 线性插值 (DFT 插值备选)
> 芯片: XC7K325T (Kintex-7) | 速度: -2
> 日期: 2026-06-02 | 版本: v1.0

---

## 1. 算法概述

### 1.1 原理

基于 802.11a OFDM 系统的导频辅助信道估计：

1. **LS 估计**: $H_{pilot}(k) = Y_{pilot}(k) \cdot X^*_{pilot}(k)$
   - 导频 BPSK (±1)，简化为符号选择
2. **线性插值**: $H(n) = H_p(k) + \frac{H_p(k+1)-H_p(k)}{d} \cdot (n-n_k)$
   - 4 个导频，间距 14 子载波，3 个内部间隙
3. **DFT 插值 (备选)**: IFFT → 时域加窗 → FFT

### 1.2 定点格式

| 信号 | 格式 | 位宽 | 处理 |
|:----:|:----:|:----:|------|
| Y(k) | Q2.14 | 16-bit | FFT 输出直接传入 |
| H_pilot | Q2.14 | 16-bit | LS: 仅符号选择，零量化误差 |
| slope | Q2.14 | 18-bit | ΔH × α，收敛舍入 |
| H_interp | Q2.14 | 16-bit | 累积器 + 收敛舍入 |

---

## 2. 实现架构

### 2.1 模块层次

```
channel_est_top
├── ls_estimator          ← 导频提取 + LS (BOPSK 符号选择)
├── channel_interpolator  ← 斜率计算 + 线性插值输出
│   ├── 斜率引擎 (DSP48)
│   └── 累积器 (LUT)
```

### 2.2 流水线

```
[symbol N] FFT → ls_estimator captures pilots    (64 clk)
[symbol N] interpolator computes slopes           (3 clk)
[symbol N] interpolator outputs H[0:63]            (64 clk)
[symbol N+1] FFT → ls_estimator captures (overlap with N output)
```

### 2.3 延迟

| 阶段 | 时钟周期 |
|:----:|:--------:|
| LS 估计 (导频提取) | 0 (随 FFT 输出流水) |
| 斜率计算 (3 个斜率) | 3 (DSP48 流水线) |
| 插值输出 (64 子载波) | 64 |
| **总延迟** | **~131 clk @ 100 MHz = 1.31 μs** |

---

## 3. 资源与性能

### 3.1 资源占用

| 资源 | LS+线性插值 | LS+DFT (含 FFT) | 可用 (XC7K325T) |
|:----:|:----------:|:--------------:|:---------------:|
| DSP48E1 | 2 | 5 | 840 (0.2%) |
| LUT | 350 | 1,600 | 203,800 (0.2%) |
| FF | 250 | 1,100 | 407,600 (0.1%) |
| BRAM 36K | 0.5 | 1.5 | 445 (0.1%) |

### 3.2 性能

| 指标 | 值 |
|:----:|:---:|
| Fmax | > 200 MHz |
| 吞吐率 | 1 OFDM 符号 / 64 clk |
| 延迟 | 1.31 μs (1 OFDM 符号 + 流水线) |

---

## 4. 性能验证

### 4.1 MATLAB 仿真 (Stage 2)

| 测试 | 条件 | MSE | 状态 |
|:----|:----|:---:|:----:|
| LS+线性插值 | Rayleigh, SNR=20dB | -14.2 dB | ✅ |
| LS+DFT 插值 | Rayleigh, SNR=20dB | -17.8 dB | ✅ |
| AWGN 信道 | SNR=30dB | -42.1 dB | ✅ |
| SNR 扫描 | 0~30dB, 7点 | 单调下降 | ✅ |
| 调制兼容 | QPSK/16QAM/64QAM | 均 < -8 dB | ✅ |

### 4.2 定点验证 (Stage 3)

| 指标 | 浮点 | Q2.14 定点 | 损失 |
|:----:|:----:|:----------:|:----:|
| MSE (LS+Linear) | -14.2 dB | -14.0 dB | 0.2 dB |
| MSE (LS+DFT) | -17.8 dB | -17.5 dB | 0.3 dB |
| SQNR | — | 82.5 dB | — |

### 4.3 RTL 仿真 (Stage 6)

| 测试 | 输入 | 预期 H | 结果 |
|:----|:----|:------:|:----:|
| 平坦信道 | H=1+0j | 全 1+0j | ✅ |
| 恒定信道 | H=0.5+0.5j | 0.5+0.5j (DC=1+0j) | ✅ |

---

## 5. OFDM 系统联合分析

### 5.1 联合资源

| 模块 | OFDM发射 | OFDM接收 | 信道估计 | 总计 |
|:----:|:--------:|:--------:|:--------:|:----:|
| DSP48 | 12 | 12+3(FFT) | 2 | 29 |
| LUT | 3,400 | 4,200 | 350 | 7,950 |
| BRAM | 5 | 6 | 0.5 | 11.5 |

### 5.2 系统占比 (XC7K325T)

| 资源 | OFDM+RRC+CE 总用 | 可用 | 占比 |
|:----:|:---------------:|:----:|:----:|
| DSP48E1 | 46 | 840 | 5.5% |
| LUT | 14,150 | 203,800 | 6.9% |
| BRAM | 12 | 445 | 2.7% |

> 完整的 OFDM 收发链路 + RRC 成形滤波 + 信道估计，总资源 < 7%。

---

## 6. 结论与建议

### 6.1 关键结论

1. **LS + 线性插值** 资源极低 (2 DSP48, ~350 LUT)，适用于所有平台
2. **LS + DFT 插值** 可复用 OFDM 解调 FFT，额外开销仅 IFFT 4 点
3. **定点化损失 < 0.3 dB**，Q2.14 格式充分满足系统需求
4. **流水线延迟 1.31 μs**，远小于 OFDM 符号周期 (4 μs @ 20 MHz)
5. **导频固定序列** 使得 LS 估计只需符号选择，零乘法开销

### 6.2 设计建议

| 场景 | 推荐 | 理由 |
|:----:|:----:|------|
| 低功耗/低成本 | LS + 线性插值 | 0~2 DSP48，~350 LUT |
| 高性能链路 | LS + DFT 插值 | MSE 改善 3-5 dB |
| 大规模 MIMO | LS + 线性 (LUT 乘法) | 可省 DSP48，纯 LUT 实现 |

### 6.3 后续工作

- [ ] 信道均衡器 (单抽头频域均衡)
- [ ] 导频序列跟踪 (符号间变化)
- [ ] MMSE 估计器 (需噪声方差估计)
- [ ] 自适应插值方法选择 (线性 vs DFT)
