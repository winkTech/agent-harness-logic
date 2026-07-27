---
name: report-rrc-fpga-implementation
algorithm: "RRC成形滤波器"
version: "1.0"
status: "final"
created: "2026-06-02"
tags: [comm, rrc, report, fpga]
---

# RRC 脉冲成形滤波器 — FPGA 实现报告

## 1. 概述

本文档记录 RRC 根升余弦成形滤波器的完整 FPGA 实现流程（全链路 7 阶段），包括算法分析、MATLAB 建模、定点量化、资源评估、RTL 编码和验证。

### 1.1 实现参数

| 参数 | 值 | 说明 |
|------|----|------|
| 滚降系数 α | 0.5 | 工程黄金标准 |
| 过采样倍数 L | 4 | 4 倍插值 |
| 滤波器跨度 | 8 符号 | 阻带衰减 > 40 dB |
| 抽头数 | 33 | $L \times span + 1$ |
| 系数量化 | 16-bit Q1.15 | 对称折叠 |
| 数据格式 | 16-bit Q2.14 | 匹配 OFDM 接口 |
| 滤波器结构 | 多相 FIR | 4 相位并行 |
| 接口协议 | AXI4-Stream | 32-bit I/Q 复包 |

### 1.2 文件清单

| 阶段 | 文件 | 说明 |
|:----:|------|------|
| 1 | `algorithm_spec.md` | 算法规格书 |
| 2 | `engineering-assets/models/comm/rrc/config.m` | 系统配置 |
| 2 | `engineering-assets/models/comm/rrc/rrc_coeff_gen.m` | RRC 系数生成 |
| 2 | `engineering-assets/models/comm/rrc/rrc_pulse_shaping.m` | 脉冲成形函数 |
| 2 | `engineering-assets/models/comm/rrc/run_rrc_sim.m` | 主仿真脚本 |
| 2 | `engineering-assets/models/comm/rrc/run_all_tests.m` | 回归测试 |
| 2 | `engineering-assets/models/comm/rrc/tests/` (5 files) | 测试用例 |
| 3 | `fixed_point_report.md` | 定点量化报告 |
| 4 | `resource_estimate.md` | 资源评估报告 |
| 5 | `rtl/src/rrc_top.sv` | 顶层模块 |
| 5 | `rtl/src/rrc_polyphase_fir.sv` | 多相 FIR 核心 |
| 5 | `rtl/src/rrc_coeff_pkg.sv` | 系数包 |
| 6 | `rtl/sim/tb_rrc_top.sv` | 自检 Testbench |
| 6 | `rtl/sim/run_sim.do` | ModelSim 脚本 |

---

## 2. 算法原理

RRC 滤波器实现无码间干扰（Zero-ISI）传输。发射端 RRC 与接收端 RRC 级联等效为升余弦响应：

$$H_{rrc}(f) = \sqrt{H_{rc}(f)}$$

**时域冲激响应**（$t \neq 0$ 且 $t \neq \pm T_s/4\alpha$）：

$$h_{rrc}(t) = \frac{\sin\left(\pi(1-\alpha)\frac{t}{T_s}\right) + 4\alpha\frac{t}{T_s}\cos\left(\pi(1+\alpha)\frac{t}{T_s}\right)}{\pi\frac{t}{T_s}\left(1 - \left(4\alpha\frac{t}{T_s}\right)^2\right)}$$

---

## 3. MATLAB 浮点模型

### 3.1 系数生成

使用直接时域公式计算 33 个 RRC 系数，归一化后保存为 Q1.15 格式。

系数分布（α=0.5, L=4）：

```
        中心抽头 h[16] = 0.7071
        对称对: h[15]=h[17], h[14]=h[18], ..., h[0]=h[32]
        最小系数: h[8] = h[24] = -0.0212
```

### 3.2 仿真验证

5 个测试用例全部通过：

| 测试 | 覆盖 | 结果 | 关键指标 |
|------|------|:----:|---------|
| test_normal | QPSK 基础成形 | PASS | EVM < -50 dB |
| test_modulations | 16QAM/64QAM | PASS | EVM < -48 dB |
| test_boundary | α=0.22/0.35/0.5, L=2/4/8 | PASS | 全部通过 |
| test_quantization | 12/16/32 位对比 | PASS | 16bit 优于 12bit > 3 dB |
| test_impulse_response | RRC+RRC=RC ISI 验证 | PASS | ISI < -40 dB |

### 3.3 关键性能

- 浮点 EVM: < -60 dB (基准)
- 定点 (16-bit) EVM: < -50 dB
- 阻带衰减: > 40 dB
- ISI 功率: < -45 dB

---

## 4. 定点量化

### 4.1 量化节点

| 节点 | Q 格式 | 位宽 | 策略 |
|------|--------|:----:|------|
| 输入符号 | Q2.14 | 16 | 匹配 OFDM |
| 滤波器系数 | Q1.15 | 16 | 偶对称折叠 |
| MAC 累加 | Q8.30 | 38 | 无中间舍入 |
| 输出 | Q2.14 | 16 | 收敛舍入 + 饱和 |

### 4.2 噪声预算

| 噪声源 | 功率 (dB) |
|--------|:---------:|
| 系数量化 (16-bit) | -96.5 |
| 输出截断 (16-bit) | -84.3 |
| **总 EVM** | **< -50 dB** |

> RRC 定点 EVM 远优于 OFDM 64QAM 的 -30 dB 要求，占系统 EVM 预算 < 0.1%。

---

## 5. 资源评估

### 5.1 资源消耗

| 资源 | 用量 | XC7K325T | 占比 |
|:----:|:----:|:--------:|:----:|
| DSP48 | 5 | 840 | **0.6%** |
| LUT | 2800 | 203800 | **1.4%** |
| FF | 1380 | 407600 | **0.3%** |
| BRAM | 0.5 | 445 | **0.1%** |

### 5.2 DSP48 映射

5 个 DSP48E1，每个 16×16 乘法映射到单 DSP48（25×18 原生支持），无需级联。

### 5.3 与 OFDM 级联

| 子系统 | DSP48 | LUT | BRAM |
|--------|:-----:|:---:|:----:|
| OFDM TX | 12 | 3400 | 5 |
| RRC (本设计) | 5 | 2800 | 0.5 |
| **合计** | **17** | **6200** | **5.5** |
| 占比 | **2.0%** | **3.0%** | **1.2%** |

---

## 6. RTL 实现

### 6.1 架构

```
                  ┌────────────────────────────────┐
  sym_in ────────►│ 符号移位寄存器 (×8)           │
                  │  对称预加 (I+Q)                │
                  │     5×DSP48 乘法               │
                  │     加法树累加                  │
                  │     收敛舍入 + 饱和截断        │
                  └────────────────────────────────┘
                               │
                           m_axis_tdata
```

### 6.2 流水线阶段

| 阶段 | 功能 | 延迟 |
|:----:|------|:----:|
| 0 | 输入寄存器切片 | 1 clk |
| 1 | 对称预加 + DSP48 乘法 | 1 clk |
| 2 | 加法树 (5→1) | 1 clk |
| 3 | 收敛舍入 + 饱和截断 | comb |
| 4 | 输出寄存器切片 | 1 clk |
| **总延迟** | | **4 clk** |

### 6.3 时序

- 时钟: 100 MHz
- 符号输入率: 1 MSps
- 样点输出率: 4 MSps
- DSP48 关键路径: > 400 MHz → 裕度充足

---

## 7. 验证策略

### 7.1 仿真验证流

```
MATLAB 浮点模型
      │
      ▼
生成测试向量 (hex) ──────► RTL 仿真
      │                         │
      ▼                         ▼
MATLAB 定点模型               DUT 输出
      │                         │
      └───── 自动比对 ──────────┘
               │
               ▼
          PASS/FAIL
```

### 7.2 测试覆盖

| 场景 | 条件 | 验证项 |
|------|------|--------|
| QPSK 正常 | α=0.5, L=4 | EVM, 星座图 |
| 16QAM/64QAM | α=0.5, L=4 | 高阶调制兼容 |
| 边界条件 | α=0.22/0.35, L=2/8 | 参数范围 |
| 系数量化 | 12/16/32bit | 精度对比 |
| ISI 特性 | RRC+RRC → RC | 零 ISI 验证 |

---

## 8. 结论

### 8.1 实现总结

RRC 成形滤波器全链路 7 阶段实现完成，共 **16 个文件**：

| 指标 | 目标 | 实际 | 判定 |
|------|:----:|:----:|:----:|
| EVM | < -45 dB | **< -50 dB** | ✅ |
| 阻带衰减 | > 36 dB | **> 40 dB** | ✅ |
| DSP48 | < 12 | **5** | ✅ |
| 吞吐率 | 4 MSps | **4 MSps** | ✅ |
| 延迟 | < 10 clk | **4 clk** | ✅ |

### 8.2 下一步

按优先级排序：
1. **信道估计 (LS/MMSE)** — 下一算法
2. **同步** — 时频同步
3. **LDPC** — 信道编码

---

## 附录: 与 OFDM 系统的集成

RRC 成形滤波器位于 OFDM 发射链路之后：
```
OFDM TX → RRC 成形 (×4) → DAC → 射频
         (Q2.14)   (Q2.14)
```

接口直接兼容：32-bit AXI4-Stream, Q2.14 格式，100 MHz 时钟。
