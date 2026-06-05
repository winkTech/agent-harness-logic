---
title: "Lowphy 链路架构 (FFT/IFFT/CP/相位补偿/交换)"
tags: [comm, 5g-nr, lowphy, fft, phase-comp]
description: "┌────────────────────────────────┐"
related: [5g-nr/bfp-compression.md, 5g-nr/dfe-architecture.md, 5g-nr/fr2-beam-management.md, 5g-nr/mimo-detection.md, 5g-nr/nr-frame-structure.md, 5g-nr/nr-ldpc.md]
---
# Lowphy 链路架构 (FFT/IFFT/CP/相位补偿/交换)

> 最后更新: 2026-06-03
> 关联: [[oran-interface]], [[dfe-architecture]], [[bfp-compression]], [[../lte/overview]]

---

## 1. Lowphy 位置与功能

```
DU (MAC/High-PHY)
    │
    │ ORAN CUS (eCPRI)
    ▼
┌────────────────────────────────┐
│          Lowphy               │
│  ┌──────┐  ┌──────┐  ┌───┐  │
│  │BFP解压│→│相位补偿│→│IFFT│  │  DL
│  └──────┘  └──────┘  └───┘  │
│                               │
│  ┌───┐  ┌──────┐  ┌──────┐  │
│  │FFT│→│相位补偿│→│BFP压缩│  │  UL
│  └───┘  └──────┘  └──────┘  │
└────────────────────────────────┘
    │
    │ JESD204B (数字中频)
    ▼
┌───────────┐
│    DFE    │  CFR/DPD
└───────────┘
    │
    ▼
   DAC/ADC → RF → 天线
```

Lowphy 的本质：**频域 ↔ 时域 的实时变换**，处理所有符号级的物理层操作。

---

## 2. DL 处理链

### 2.1 下行流程

```
ORAN U-plane (频域系数) → BFP 解压 → 相位补偿 → 资源映射
    → IFFT → CP 插入 → 时域数据输出 → DFE
```

### 2.2 资源映射

```
┌──────────────────────────────────────┐
│              IFFT 输入               │
├──────────────────────────────────────┤
│  [0,...,0, D0, D1, ..., Dn, 0,...,0]│
│   ↑DC    ↑ 有效子载波          ↑Guard│
└──────────────────────────────────────┘
配置参数:
  - IFFT 尺寸: 4096/2048 (取决于带宽)
  - 有效子载波数: 3300 (100MHz NR, μ=1)
  - DC 子载波: 置零 (索引 N/2)
  - 保护间隔: 两端边缘子载波
```

### 2.3 FFT/IFFT 配置

| NR SCS | 信道带宽 | FFT 尺寸 | 采样率 | CP 长度 (常规) |
|:------:|:-------:|:--------:|:------:|:-------------:|
| 15kHz (μ=0) | 10~50MHz | 1024 | 15.36MHz | 72/80 |
| 30kHz (μ=1) | 10~100MHz | 2048 | 30.72MHz | 144/160 |
| 60kHz (μ=2) | 10~200MHz | 4096 | 61.44MHz | 288/320 |
| 120kHz (μ=3) | 50~400MHz | 8192 | 122.88MHz | 576/640 |

**CP 长度**:
- 第一个符号 (symbol 0 per slot): $144 \cdot 2^{-\mu} + 16$ 采样点
- 其他符号 (symbol 1~13): $144 \cdot 2^{-\mu}$ 采样点

---

## 3. 相位补偿

### 3.1 为什么需要相位补偿

5G NR Lowphy 的频域数据来自 ORAN C-plane 调度，但 **时域 IFFT 窗口的中心频率不同**，导致频偏:

- 5G NR 支持灵活的 **部分带宽 BWP**
- 频域数据是相对于 **某频点** 的基带 IQ
- 做 IFFT/FFT 时，时域信号需要 **乘以相位旋转因子** 以抵消频移

### 3.2 相位旋转公式

DL: 
$$y(n) = x(n) \cdot e^{-j2\pi \cdot f_{shift} \cdot t(n)}$$

UL:
$$Y(k) = X(k) \circledast e^{-j\phi(k)} \text{(等效频域)}$$

或简化为时域乘法:

$$s_{comp}(n) = s_{IFFT}(n) \cdot e^{-j2\pi \cdot \Delta f \cdot n / N_{FFT}}$$

其中:
- $\Delta f$ 是频率偏移 (子载波为单位)
- $n$ 是时域采样点索引
- $N_{FFT}$ 是 FFT 尺寸

### 3.3 FPGA 实现

```verilog
// 相位补偿 (DL)
// 每个采样点乘以复指数 e^{-j·θ(n)}
// θ(n) = 2π × Δf × n / N_FFT

// CORDIC 或 ROM 查找表实现
// 需要支持多频点 (每个 BWP 配置不同相位)

always_ff @(posedge clk) begin
    phase_acc <= phase_acc + phase_step; // Δf 决定步长
    // 查 sin/cos ROM
    comp_i <= iq_i * cos_lut[phase_acc] + iq_q * sin_lut[phase_acc];
    comp_q <= iq_q * cos_lut[phase_acc] + iq_i * sin_lut[phase_acc];
end
```

**资源**: 每个天线需要一个相位旋转乘法器 (2 个复数乘法器)

---

## 4. 符号级交换

### 4.1 为什么需要符号交换

某些 O-RU 实现中，ORAN C-plane 和 U-plane 的 **符号编号不一致**，需要在 Lowphy 内部做 **符号重排**:

```
示例: C-plane 按 slot-relative 编号 vs U-plane 按 frame-relative 编号
  C-plane: 符号 0~13 (每 slot)
  U-plane: 符号 0~139 (每帧)
  
  C-plane section.symInc = 1 表示 section 应用于连续符号
  交换逻辑需要将 C-plane 符号 ID 映射到实际 IFFT 处理的时间
```

### 4.2 交换模式

| 模式 | 描述 | 使用场景 |
|:----|:----|:---------|
| Passthrough | 不交换 | 标准 C-plane 对齐 |
| Symbol reorder | 按映射表交换 | C-plane/U-plane 符号偏移 |
| Slot shift | 时隙整体偏移 | TDD 上下行切换点 |
| Symbol duplication | 重复某些符号 | 测试模式 / 特例 |

### 4.3 实现

```
C-plane 配置 → 交换表 RAM [14 × beamId] → 每个符号查询
    → 选择对应频域数据映射到 IFFT
```

双缓冲设计: 交换表在 **符号 13 完成时更新**，下一 slot 立即生效。

---

## 5. CP 插入/去除

### 5.1 CP 插入 (DL)

```
IFFT 输出 (N 点)
┌────┬────┬────┬────┬────┬────┐
│ s0 │ s1 │ s2 │ ... │sN-2│sN-1│
└────┴────┴────┴────┴────┴────┘
          ↓ 复制尾部
┌────┬────┬────┬────┬────┬────┐
│sN-CP  ... sN-1 │ s0 │ s1 │ ... │sN-1│
└────────────────┴────────────────┘
   CP (C 点)          有效符号 (N 点)
```

### 5.2 CP 去除 (UL)

```
ADC 采样 → 检测符号起始 → 丢弃前 C 个采样点 → N 点 FFT
```

### 5.3 可变 CP 长度

```verilog
// CP 长度参数化
case (symbol_id)
    0: cp_len <= 144 * (2**(-mu)) + 16;
    default: cp_len <= 144 * (2**(-mu));
endcase

// NCO 控制每个符号的输出采样数
// 每个符号: N_FFT + cp_len 个采样点
```

---

## 6. 窗口化 (Windowing)

为降低 **频谱泄漏**，可在 CP 边缘做时域加窗:

```
IFFT 输出 → 加窗 → CP 插入 → 重叠叠加 → 输出
```

通用窗函数: **Raised-cosine (RC)** 或 **Blackman**，窗口重叠长度通常为 CP 的 ~5%

---

## 7. 关键性能指标

| 指标 | 要求 | 测量方式 |
|:----|:----|:--------|
| ACLR (邻道泄漏比) | >45 dB | 频谱测量 |
| EVM (误差向量幅度) | <3.5% (256QAM) | 解调分析 |
| 相位噪声 | < -130 dBc/Hz @10kHz | 频谱仪 |
| 时延 (Lowphy only) | < 20μs | 回环测试 |

---

## 8. FPGA 实现要点

### 8.1 流水线架构

```
┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐
│ BFP解压  │→│ 相位补偿 │→│ 资源映射  │→│  IFFT   │→│ CP插入 │
│ (1clk/L) │  │ (4clk)  │  │ (1clk/R) │  │(N/2clk) │  │(流水线) │
└─────────┘  └─────────┘  └─────────┘  └─────────┘  └────────┘
```

- 每个模块 **流水线级** 独立，用 valid/ready 握手
- FFT IP 核选择策略:
  - 性能模式: 流水线 Streaming I/O (每时钟 1 采样点)
  - 面积模式: 突发 Radix-2 (共享乘法器)

### 8.2 双符号缓冲

```
符号 N 处理中 → IFFT 引擎繁忙
符号 N+1 数据 → BFP 解压 + 相位补偿 → 缓冲
符号 N 处理完成 → 交换 buffer → 符号 N+1 开始
```

- 避免 IFFT 引擎空闲等待
- 至少需 2 个完整的 **频域系数 buffer** (每符号)

### 8.3 同步设计

所有模块使用 **同一时钟源** (S-plane 恢复):
1. 采样时钟: 30.72/61.44/122.88 MHz
2. 符号脉冲: IFFT 完成 → CP 插入 → symbol_start 脉冲
3. 帧脉冲: 每 10ms 帧对齐

### 8.4 资源估算 (100MHz NR, 4T4R)

| 模块 | BRAM | DSP48 | LUT | FF |
|:----|:----:|:-----:|:---:|:--:|
| BFP 解压 (×4) | 0 | 0 | ~2K | ~2K |
| 相位补偿 (×4) | 0 | 16 | ~4K | ~2K |
| 资源映射 (×4) | 8 | 0 | ~2K | ~1K |
| IFFT 4096 (×4) | 48 | 64 | ~20K | ~20K |
| CP 插入 (×4) | 0 | 0 | ~1K | ~2K |
| 总计 | ~56 | ~80 | ~29K | ~27K |

**实际**: 4T4R Lowphy 可在一片中型 FPGA (XCZU67DR) 内实现，占总资源约 30-40%
