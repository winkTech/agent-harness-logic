---
title: "OFDM 发射机 FPGA 实现技术报告"
tags: [comm, ofdm, impl]
description: "本报告记录 OFDM 发射机从算法分析到 FPGA 实现的全链路过程。OFDM (Orthogonal Frequency Division Multiplexing) 是 4G/5G/WiFi 的核心物理层技术，通过将高速数据流分解为多个并行低速子载波实现高效传输。"
related: [ofdm/algorithm_spec.md, ofdm/fixed_point_report.md, ofdm/resource_estimate.md, ofdm/rtl_architecture.md, ofdm/testbench_plan.md]
---
# OFDM 发射机 FPGA 实现技术报告

**日期:** 2026-06-02
**版本:** v1.0
**算法:** OFDM (802.11a 基带发射机)
**目标器件:** XC7K325T

---

## 1. 概述

本报告记录 OFDM 发射机从算法分析到 FPGA 实现的全链路过程。OFDM (Orthogonal Frequency Division Multiplexing) 是 4G/5G/WiFi 的核心物理层技术，通过将高速数据流分解为多个并行低速子载波实现高效传输。

**主要参数:**
- FFT 点数: 64 (可扩展至 256/1024/2048)
- CP 长度: 16 (可配置)
- 调制方式: BPSK/QPSK/16QAM/64QAM
- 采样率: 20MHz (基带)
- 数据子载波: 48
- 导频子载波: 4

**实现架构:**
```
BitStream → Mod Mapper → Pilot Insert → IFFT → CP Insert → Output
```

---

## 2. 算法原理

### 2.1 核心数学

OFDM 发射将频域符号通过 IFFT 变换为时域信号:

$$x[n] = \frac{1}{\sqrt{N}} \sum_{k=0}^{N-1} X_k \cdot e^{j2\pi kn/N}, \quad n=0,...,N-1$$

子载波间隔 $\Delta f = f_s / N$，OFDM 符号周期 $T_{sym} = (N + N_{CP}) / f_s$。

### 2.2 子载波分配 (802.11a, 64点FFT)

| 类型 | 数量 | 索引 |
|------|------|------|
| 数据 | 48 | -26~-22, -20~-8, -6~-1, 1~6, 8~20, 22~26 |
| 导频 | 4 | -21, -7, 7, 21 |
| DC | 1 | 0 |
| 保护带 | 11 | -32~-27, 27~31 |

---

## 3. MATLAB 浮点模型

### 3.1 模型结构

`golden_model/` 包含完整 OFDM 收发链路:

| 文件 | 功能 |
|------|------|
| `config.m` | 参数配置 (FFT/CP/调制/采样率) |
| `tx_chain.m` | 发射链路: 数据生成→调制→IFFT→加CP |
| `rx_chain.m` | 接收链路: 去CP→FFT→解调 |
| `mod_mapper.m` | 调制映射 (BPSK/QPSK/16QAM/64QAM Gray编码) |
| `ifft_chain.m` | IFFT 变换 (含 FFT shift) |
| `add_cp.m` | 循环前缀添加 |
| `generate_vectors.m` | 测试向量导出 (.bin格式) |

### 3.2 测试结果 (预期)

| 测试项 | 条件 | 预期结果 |
|--------|------|----------|
| BER | 理想信道 | 0 (完美恢复) |
| 多调制 | BPSK/QPSK/16QAM/64QAM | 全部 BER=0 |
| 边界 | 全零输入 | IFFT输出零 |
| 边界 | 单频(DC) | 时域常数 |

### 3.3 性能基线 (浮点)

| 指标 | QPSK | 16QAM | 64QAM |
|------|------|-------|-------|
| PAPR (99.9%) | ~10.5dB | ~11.0dB | ~11.2dB |
| EVM (浮点) | 基准 | 基准 | 基准 |

---

## 4. 定点量化

### 4.1 位宽方案

| 节点 | 整数 | 小数 | 总位宽 | 格式 |
|------|------|------|--------|------|
| 调制符号 | 2 | 14 | 16 | Q2.14 |
| 频域网格 | 2 | 14 | 16 | Q2.14 |
| IFFT输入 | 2 | 14 | 16 | Q2.14 |
| IFFT输出 | 3 | 13 | 16 | Q3.13 (BFP) |
| 加CP后 | 3 | 13 | 16 | Q3.13 |

### 4.2 选定理由

- **16bit** 是最优性价比: 低于16bit 量化噪声恶化 EVM (>0.5dB)，高于16bit 消耗额外 DSP48
- **DSP48 适配**: 16×16 乘法完美适配单 DSP48E1 (25×18)，无需级联
- **IFFT 缩放**: Block Floating Point 自动管理，避免溢出

### 4.3 定点性能预估

| 指标 | 浮点 | 定点 (16bit) | 退化 |
|------|------|-------------|------|
| EVM | 基准 | < -48dB | < 0.1dB |
| BER (理想信道) | 0 | 0 | 无 |

---

## 5. 资源评估

### 5.1 各模块资源

| 模块 | DSP48 | LUT | FF | BRAM |
|------|-------|-----|----|------|
| Mod Mapper | 0 | 80 | 50 | 0 |
| Pilot Insert | 0 | 120 | 100 | 0 |
| IFFT (FFT IP) | 12 | 2800 | 3200 | 3 |
| CP Insert | 0 | 400 | 600 | 2 |
| **合计** | **12** | **3400** | **3950** | **5** |

### 5.2 目标器件预算

| 资源 | XC7K325T | 消耗 | 占比 | 裕量 |
|------|----------|------|------|------|
| DSP48 | 840 | 12 | 1.4% | 98.6% |
| LUT | 203,800 | 3,400 | 1.7% | 98.3% |
| BRAM | 445 | 5 | 1.1% | 98.9% |

单 OFDM 发射机仅占 XC7K325T **不到2%** 的资源，4发 MIMO 也仅需不到 10%。

---

## 6. RTL 架构

### 6.1 模块清单

| 模块 | 文件 | 功能 |
|------|------|------|
| `ofdm_tx_top` | `ofdm_tx_top.sv` | 顶层, AXI4-Stream 接口 |
| `mod_mapper` | `mapper.sv` | 调制映射, 3级流水线 |
| `pilot_insert` | `pilot_insert.sv` | 导频/DC/Guard 插入 |
| `cp_insert` | `cp_insert.sv` | CP 插入, Dual RAM Ping-Pong |

### 6.2 流水线

| 级 | 模块 | 延迟(clk) |
|----|------|-----------|
| 1 | Input | 1 |
| 2 | Mod Mapper | 2 |
| 3 | Pilot Insert | 1 |
| 4 | IFFT | ~65 (流水线) |
| 5 | CP Insert | N_CP (吞吐无气泡) |
| **总** | | **~85** |

### 6.3 接口

- 输入: AXI4-Stream (6bit 数据 + VALID/READY/TLAST)
- 输出: AXI4-Stream (32bit I/Q 交错 + VALID/READY/TLAST)
- 吞吐: 1 sample/clock (连续模式)

---

## 7. 验证方案

### 7.1 测试用例

| 用例 | 调制 | 说明 |
|------|------|------|
| TC1 | QPSK | 基础功能验证 |
| TC2 | BPSK | 最小调制 |
| TC3 | 16QAM | 高密度调制 |
| TC4 | 64QAM | 最大调制 |
| TC5 | 全零 | 边界检查 |
| TC6 | 单频 | 边界检查 |

### 7.2 验证流程

```
MATLAB 浮点模型 → 生成测试向量 (.bin)
         ↓
    RTL 仿真读入向量
         ↓
    DUT 输出 → 与 MATLAB golden 逐比特比对
         ↓
    PASS/FAIL 自动判定 (tolerance = 1 LSB)
```

---

## 8. 总结与扩展

### 8.1 实现结论

- ✅ 成功建立 7 阶段全链路流程 (分析→浮点→定点→资源→RTL→验证→报告)
- ✅ OFDM 发射机定点方案 16bit (Q2.14/Q3.13)
- ✅ RTL 架构完整，吞吐 1 sample/clock
- ✅ 资源消耗极低 (XC7K325T < 2%)

### 8.2 下一步扩展

| 优先级 | 算法 | 说明 |
|--------|------|------|
| P0 | 成形滤波 (RRC) | 脉冲成形, DSP48消耗大需评估 |
| P1 | 信道估计 (LS/MMSE) | 涉及矩阵运算, 定点是关键难点 |
| P1 | 时频同步 | 反馈环路定点, 架构复杂 |
| P2 | LDPC 译码 | 迭代算法, 定点退化敏感 |

### 8.3 可交付物清单

| 交付物 | 位置 |
|--------|------|
| 算法规格书 | `algorithm_spec.md` |
| MATLAB 黄金模型 | `golden_model/` (11个文件) |
| 定点量化报告 | `fixed_point_report.md` |
| 资源评估报告 | `resource_estimate.md` |
| RTL 源码 | `rtl/src/` (4个SV模块) |
| Testbench | `rtl/tb_tx_top.sv` |
| 仿真脚本 | `rtl/run_sim.do` |
| 本报告 | `report_ofdm_fpga_implementation.md` |
