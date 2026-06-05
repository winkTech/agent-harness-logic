# DFE 数字前端处理模块

> 最后更新: 2026-06-03
> 关联: [[lowphy-architecture]], [[oran-interface]], [[bfp-compression]]

---

## 1. DFE 概述

### 1.1 DFE 在 O-RU 中的位置

```
Lowphy (IFFT/FFT)
    │
    │ JESD204B (数字IQ, 通常为 16bit 定点)
    ▼
┌────────────────────────────────────┐
│            DFE                    │
│  ┌────────────────────────────┐   │
│  │   DL: CFR → DPD → DAC     │   │
│  │   UL: ADC → DDC → JESD    │   │
│  └────────────────────────────┘   │
└────────────────────────────────────┘
    │
    ▼
  RF / PA / Antenna
```

### 1.2 核心功能

| 功能 | 全称 | 作用 |
|:----|:----|:----|
| **CFR** | Crest Factor Reduction | 峰均比抑制 (削峰) |
| **DPD** | Digital Pre-Distortion | 数字预失真 (PA 线性化) |
| **DDC** | Digital Down Converter | 数字下变频 (ADC→基带) |
| **DUC** | Digital Up Converter | 数字上变频 (基带→DAC) |

---

## 2. CFR (Crest Factor Reduction)

### 2.1 为什么需要 CFR

OFDM/CP-OFDM 信号 **PAPR 高** (典型 10~12dB):
- 高峰值 → PA 进入饱和区 → 非线性失真 → ACLR 劣化
- CFR 将峰值降低到 PA 线性区内 → 提升 PA 效率

### 2.2 工作原理

```
输入信号 ─→ 幅度检测 ─→ 峰值定位 ─→ 加窗/滤波 ─→ 信号减去削峰噪声
```

**峰值检测**:
$$threshold = CL \times RMS = CL \times \sqrt{E[|x(n)|^2]}$$

其中 CL 为削峰门限 (dB)，典型值 7~9dB (根据 PA 特性配置)

### 2.3 算法实现

#### 硬削峰 (Hard Clipping)

$$y(n) = \begin{cases} x(n), & |x(n)| \leq A_{max} \\ A_{max} \cdot \frac{x(n)}{|x(n)|}, & |x(n)| > A_{max} \end{cases}$$

**缺点**: 产生高带外频谱泄漏 → EVM 劣化

#### 窗函数削峰 (Windowing CFR)

```
1. 检测信号包络 p(n) = |x(n)|
2. 超过门限部分: c(n) = x(n) × (1 - A_max/p(n)) 当 p(n) > A_max
3. 对 c(n) 加窗平滑: c_w(n) = c(n) * w(n) (窗长 16~64 采样)
4. 输出: y(n) = x(n) - c_w(n)
```

**常见窗函数**: Hamming, Hanning, Kaiser (β 可调)

#### 迭代削峰 (PC-CFR, Peak Cancellation)

```
For each iteration:
  1. 找最大峰值位置及幅度
  2. 生成对应位置的脉冲抵消信号
  3. 从原信号减去
  4. 检查是否仍有超限峰值
```

实现更复杂但 EVM 控制更好，适合 256QAM 信号。

### 2.4 FPGA 实现

| 方法 | DSP48 | BRAM | LUT | EVM 劣化 | ACLR 改善 |
|:----|:----:|:----:|:---:|:--------:|:---------:|
| 硬削峰 | 0 | 0 | ~50 | ~3% | ~5dB |
| 窗函数法 | 4 | 1 | ~500 | ~1.5% | ~10dB |
| PC-CFR (3次迭代) | 12 | 4 | ~2000 | ~0.8% | ~15dB |

**典型配置**: 窗函数法 + 2 次 PC-CFR，均衡性能与成本。

---

## 3. DPD (Digital Pre-Distortion)

### 3.1 原理

```
输入 x ─→ DPD 模型 ─→ PA ─→ 输出 y
          ↑                    │
          └── 反馈路径 (ADC) ──┘

DPD 学习 PA 的非线性特性，对输入预失真:
  y = PA(G(x))  → 希望 y = K·x (线性放大)
  G(x) = PA^{-1}(K·x)  (预失真函数)
```

### 3.2 PA 模型

**记忆多项式 (Memory Polynomial, MP)** — 最常用:

$$y(n) = \sum_{k=1}^{K}\sum_{m=0}^{M} a_{km} \cdot x(n-m) \cdot |x(n-m)|^{k-1}$$

| 参数 | 典型值 | 说明 |
|:----|:------|:----|
| K (非线性阶数) | 7~11 | 奇次项 (1,3,5,7,9,11) |
| M (记忆深度) | 3~7 | 考虑 PA 的记忆效应 |

**广义记忆多项式 (GMP)**:
- 增加交叉项: $x(n-m) \cdot |x(n-m-l)|^{k-1}$
- 模型更精确但系数更多 (>100 参数)

### 3.3 训练流程

```
1. 捕获: 采集 PA 输入 x(n) 和输出 y(n) (反馈 ADC)
2. 对齐: 时域延迟对齐 (相关性找最佳延迟)
3. 系数估计: LS/NLS 求解 a_{km}
4. 应用: 新系数加载到 DPD 引擎
5. 监控: 持续监控 ACLR → 触发重训练
```

**LS 求解**:
$$\hat{\theta} = (X^H X + \lambda I)^{-1} X^H y$$

其中 $X$ 是记忆多项式构造的基矩阵。

### 3.4 自适应 DPD

```
           ┌─ DPD ──→ DAC ─→ PA ─→ 输出
           │                      │
           │              ┌─── ADC (反馈) ──┐
           │              │ 延迟对齐/归一化  │
           └──────────────┤  误差计算        │
                         │  自适应更新      │
                         └─────────────────┘
```

**LMS/NLMS 自适应**:
$$e(n) = y_{ref}(n) - y_{PA}(n)$$
$$\theta(n+1) = \theta(n) + \mu \cdot X^H(n) \cdot e(n)$$

### 3.5 FPGA 实现

```verilog
// DPD 引擎 (记忆多项式, K=7, M=3)
// 每时钟周期处理 1 采样点

module dpd_engine #(
    parameter K = 7,    // 非线性阶数
    parameter M = 3     // 记忆深度
) (
    input  clk,
    input  signed [15:0] x_i, x_q,
    output signed [15:0] y_i, y_q
);

// 1. 包络计算: pwr = x_i^2 + x_q^2
// 2. 查找表: |x|^(k-1) × a_km (预计算系数表)
// 3. 延迟链: M 级 x(n-m)
// 4. 加权求和: y = Σ a_km · x(n-m) · |x|^(k-1)
// 5. 复信号输出
```

**DPD 资源**: K=7, M=3 → ~42 个复乘 + 7×4=28 个系数集 → 约 80~120 DSP48

### 3.6 DPD 调试要点

| 问题 | 可能原因 | 排查方法 |
|:----|:---------|:--------|
| 收敛失败 | 延迟对齐不准 | 相关性找峰值 |
| ACLR 改善不足 | K/M 不够大 | 增加阶数测试 |
| 不稳定振荡 | 自适应步长 μ 过大 | 减小 μ / 添加泄漏因子 |
| 温度漂移 | PA 参数变化 | 温度补偿 / 定期重训练 |

---

## 4. DDC/DUC (数字变频)

### 4.1 DUC (DL)

```
基带 IQ (30.72MS/s) ─→ 插值滤波 ─→ 混频 ─→ 合成 ─→ DAC (245.76MS/s)
                         ↑          ↑
                      HB 1/2/3    NCO (cos+sin)
```

**多级插值 (HBF + CIC)**:
```
基带 ─→ HB ─→ HB ─→ HB ─→ CIC ─→ DAC
×2      ×2      ×2      ×2~×8
```

- HB (半带滤波器): 每级 2 倍插值, 60~80 taps
- CIC (级联积分梳状): 大倍数插值, 面积小

### 4.2 DDC (UL)

```
ADC (245.76MS/s) ─→ 混频 ─→ CIC ─→ HB ─→ HB ─→ HB ─→ 基带 IQ
                     ↑
                  NCO (cos+sin)
```

### 4.3 NCO (数控振荡器)

$$LO(n) = cos(2\pi f_{LO} \cdot n / f_s) + j \cdot sin(2\pi f_{LO} \cdot n / f_s)$$

实现方案:
1. **CORDIC**: 旋转模式, 每时钟 1 采样, 面积小
2. **DDS (ROM LUT)**: 相位累加 + sin/cos ROM, 高速
3. **泰勒级数**: 并行计算, 精度高

---

## 5. 链路预算与动态范围

### 5.1 DL 链路

```
DAC (16bit) → 模拟增益 → PA → 天线
  ↑            ↑          ↑
  DFE 输出    PA 驱动     +43 dBm (典型, macro)
```

### 5.2 UL 链路

```
天线 → LNA → 模拟衰减 → ADC (16bit)
  ↑                     ↑
  -100 dBm 灵敏度      +10 dBm 满量程
```

### 5.3 数字增益管理

```verilog
// 数字 AGC 策略
// 1. ADC 输入过大 → 数字衰减 → 防饱和
// 2. ADC 输入过小 → 数字增益 → 充分利用动态范围
// 3. 增益变化 → 平滑过渡 (避免阶跃导致解调 error)

gain <= max_gain when rms < target_rms * 0.5
gain <= min_gain when rms > target_rms * 1.2
else hold
```

---

## 6. JESD204B 接口

DFE 与 DAC/ADC 之间通过 **JESD204B** 串行接口连接:

| 参数 | 配置 |
|:----|:----|
| 线速率 | 12.5 / 24.75 Gbps (取决于 DAC/ADC) |
| 通道数 | 8~16 (DAC 侧) / 8~16 (ADC 侧) |
| 分辨率 | 16 bit |
| 采样率 | 245.76 / 491.52 MSps |

详见 [[../../fpga/jesd204b-guide]] — JESD204B 完整指南 (线速率/参数计算/调试/PCB)

---

## 7. FPGA 资源估算 (8天线 O-RU)

| 模块 | DSP48 | BRAM (36K) | LUT | FF |
|:----|:----:|:---------:|:---:|:--:|
| CFR (PC-CFR×2) | 24 | 8 | ~8K | ~6K |
| DPD (K=7,M=3) | 128 | 16 | ~20K | ~15K |
| DDC/DUC (×8) | 64 | 16 | ~12K | ~10K |
| JESD204B (×16) | 0 | 8 | ~8K | ~10K |
| 控制/管理 | 0 | 4 | ~4K | ~3K |
| **总计** | **216** | **52** | **~52K** | **~44K** |
| ZU67DR 可用 | 1440 | 432 | 93K | 186K |
| 占比 | 15% | 12% | 56% | 24% |

**结论**: ZU67DR 可承载 8 天线 O-RU DFE（LUT 为主要瓶颈）
