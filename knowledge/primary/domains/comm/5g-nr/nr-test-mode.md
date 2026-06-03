# 5G NR 下行测试模式与 EVM 测试

> 最后更新: 2026-06-03
> 关联: [[lowphy-architecture]], [[dfe-architecture]], [[bfp-compression]], [[oran-interface]]

---

## 1. NR 测试模式概述

### 1.1 测试目的

| 测试项 | 目标 | 测试阶段 |
|:-------|:----|:---------|
| EVM 测量 | 验证调制质量 (256QAM <3.5%) | 原型 → 量产 |
| ACLR | 验证邻道泄漏 (< -45dB) | 原型 → 量产 |
| 频率误差 | 验证晶振精度 (< ±0.05 ppm) | 原型 |
| 时域模板 | 验证突发模板 | 一致性与合规 |

### 1.2 测试分类

```
┌─────────────────────┐
│   一致性测试 (Conformance) │  3GPP TS 38.141
├─────────────────────┤
│   生产测试 (Production)  │  产线快速测试
├─────────────────────┤
│   研发调试 (Debug)       │  原型板调试验证
├─────────────────────┤
│   ORAN 前传测试         │  前传接口验证
└─────────────────────┘
```

---

## 2. EVM 测试

### 2.1 EVM 定义

$$EVM = \sqrt{\frac{\sum_{k} |S_{meas}(k) - S_{ref}(k)|^2}{\sum_{k} |S_{ref}(k)|^2}} \times 100\%$$

| 参数 | LTE 要求 | NR 要求 |
|:----|:--------:|:-------:|
| QPSK EVM | <17.5% | <17.5% |
| 16QAM EVM | <12.5% | <12.5% |
| 64QAM EVM | <8% | <8% |
| 256QAM EVM | <3.5% | <3.5% |

### 2.2 EVM 测试信号

**测试模型 (NR TM, Test Model)**:

| TM | 描述 | 调制 | 信号特性 |
|:---|:----|:----|:---------|
| TM1.1 | 全分配, QPSK | QPSK | 最大 RB 数, 满功率 |
| TM2 | 全分配, 64QAM | 64QAM | 用于 ACLR 测试 |
| TM2a | 全分配, 256QAM | 256QAM | 用于 EVM 测试 |
| TM3.1 | 满分配, 16QAM | 16QAM | 用于占用带宽 |

### 2.3 EVM 测试流程

```
1. 配置 DUT 发送指定 TM 信号
2. 频谱仪/信号分析仪捕获时域数据
3. 同步 → 解调 → 解映射
4. 计算理想星座点与实际接收点偏差
5. 统计 RMS EVM / Peak EVM / 每子载波 EVM
```

### 2.4 EVM 预算分配 (256QAM)

| 误差源 | 典型贡献 | 说明 |
|:-------|:--------:|:----|
| 相位噪声 (LO) | 1.0~1.5% | 取决于 PLL/VCO 质量 |
| PA 非线性 | 1.0~2.0% | 取决于 DPD 效果 |
| DAC 量化 | 0.5~1.0% | 位数和时钟抖动 |
| BFP 压缩 | 1.0~1.5% | 6bit BFP 量化噪声 |
| 带内平坦度 | 0.5~1.0% | DFE 滤波器波纹 |
| 总 EVM (RSS) | ~2.5~3.5% | 目标 <3.5% |

$$EVM_{total} = \sqrt{EVM_{PN}^2 + EVM_{PA}^2 + EVM_{DAC}^2 + EVM_{BFP}^2 + EVM_{flat}^2}$$

---

## 3. 测试信号生成 (FPGA)

### 3.1 NR TM 信号生成

```
TM 选择 → 伪随机序列 → QAM映射 → 资源映射 → IFFT → CP → RF
                         ↑
                    QPSK/16QAM/64QAM/256QAM
```

```matlab
% 生成 NR TM1.1 (QPSK, 满RB)
function tm_signal = generate_nr_tm11(num_rb, scs, num_symbols)
    n_rb = num_rb;
    n_sc = n_rb * 12;
    
    % PRBS-31 生成
    seq = randi([0 1], n_sc * num_symbols * 2, 1);
    
    % QPSK 调制
    bits_i = seq(1:2:end);
    bits_q = seq(2:2:end);
    qam_sym = (2*bits_i - 1 + 1j*(2*bits_q - 1)) / sqrt(2);
    
    % 资源映射 (满 RB)
    grid = reshape(qam_sym, n_sc, num_symbols);
    
    % OFDM 调制
    tm_signal = ofdm_modulate(grid, scs);
end
```

### 3.2 定点 TM 生成 (FPGA 原型)

```verilog
// TM 信号生成模块
module nr_tm_gen #(
    parameter TM_SEL = 1  // 1: TM1.1, 2: TM2, 3: TM2a, 4: TM3.1
) (
    input  clk,
    input  rst_n,
    input  tm_start,
    output signed [15:0] i_out,
    output signed [15:0] q_out,
    output valid
);

// 核心逻辑:
// 1. PRBS-31 生成器 (LFSR: x^31 + x^28 + 1)
// 2. QAM 映射 (QPSK/16QAM/64QAM/256QAM LUT)
// 3. 子载波映射 (按 TM 定义的 RB 分配)
// 4. 频域填充 → IFFT IP → CP 插入
// 5. 输出时域 IQ

endmodule
```

---

## 4. EVM 测量方法

### 4.1 基于频谱仪的 EVM

```
DUT RF → 频谱仪 RF-in → 内置解调 → EVM 报告

命令 (Keysight 89600 VSA):
  :INIT:CONT OFF
  :TRIG:SOUR EXT (外部触发)
  :SENS:EVM:MEAS 1
  :FETCH:EVM? → 返回 RMS EVM / Peak EVM
```

### 4.2 基于 FPGA 回环的自测 EVM

```
FPGA Tx → 衰减器 → FPGA Rx → 数字回环解调 → EVM 计算
```

适合产线快速测试:

```matlab
% FPGA 回环 EVM 测量 (MATLAB 脚本)
function evm_result = evm_loopback_test(tx_iq, rx_iq, modulation)
    % 1. 同步
    [corr, lag] = xcorr(rx_iq, tx_iq);
    [~, idx] = max(abs(corr));
    rx_aligned = rx_iq(lag(idx)+1 : lag(idx)+length(tx_iq));
    
    % 2. 归一化
    scale = mean(abs(tx_iq)) / mean(abs(rx_aligned));
    rx_norm = rx_aligned * scale;
    
    % 3. EVM 计算
    err = tx_iq - rx_norm;
    evm_rms = sqrt(mean(abs(err).^2) / mean(abs(tx_iq).^2)) * 100;
    
    evm_result = struct('rms', evm_rms, ...
                        'peak', max(abs(err)./abs(tx_iq))*100, ...
                        'constellation', [tx_iq, rx_norm]);
end
```

### 4.3 基于 ORAN 接口的 EVM

```
DU → eCPRI (C+U) → O-RU → RF → 环回/衰减 → O-RU Rx → eCPRI (U) → DU
                                                          ↓
                                                     DU 解调 → EVM
```

**优势**: 不需要外部仪器，在 DU 侧即可完成闭环测试

**步骤**:
1. DU 发送已知 TM 矢量到 O-RU
2. O-RU 通过 DL 发射，RF 环回至 UL
3. O-RU UL 接收 → BFP 压缩 → eCPRI 回传
4. DU 解调 → 与原始 TM 参考对比 → EVM

---

## 5. 产线测试项

### 5.1 快速检查清单

| # | 测试项 | 方法 | 通过标准 | 时间 |
|:--|:------|:----|:--------|:----|
| 1 | 电源上电 | 电流检测 | 在规格内 | 1s |
| 2 | 时钟锁定 | PLL Lock 检测 | Lock 指示 | 1s |
| 3 | JESD204B 链路 | SYNC 检测 | CGS/ILA 完成 | 2s |
| 4 | ORAN C-plane 连通 | eCPRI 心跳 | 收到 C-plane | 2s |
| 5 | ORAN U-plane 连通 | 发送测试符号 | 环回正确 | 5s |
| 6 | EVM 测试 | TM2a 环回 | <3.5% (256QAM) | 10s |
| 7 | 功率精度 | 功率计 | ±0.5dB | 3s |
| 8 | 频率误差 | 解调分析 | <0.05 ppm | 5s |

### 5.2 环回测试模式

```
┌─────────────────────────────────────┐
│  FPGA                               │
│  ┌─────────┐    ┌────────┐         │
│  │ TM Gen  │───→│ Lowphy │──→ DAC  │
│  └─────────┘    │ (DL)   │    │    │
│                  └────────┘    │    │
│  ┌─────────┐    ┌────────┐    │    │
│  │ EVM Calc│←───│ Lowphy │←── ADC  │
│  └─────────┘    │ (UL)   │         │
│                 └────────┘         │
└─────────────────────────────────────┘
```

内部数字环回 (无需 RF):

```
TM Gen → Lowphy DL → 衰减/噪声注入 → Lowphy UL → EVM 计算
                     ↑
                可配置 SNR (模拟不同条件)
```

---

## 6. 常见 EVM 劣化因素

### 6.1 相位噪声

| LO 源 | 相噪 @10kHz | EVM 贡献 (@256QAM) |
|:------|:----------:|:-----------------:|
| 集成 PLL (RFSoC) | -95 dBc/Hz | ~1.0% |
| 外部 LO (优质) | -110 dBc/Hz | ~0.5% |
| 外部 LO (普通) | -85 dBc/Hz | ~2.0% |

**缓解**:
- 使用低相噪参考时钟
- PLL loop bandwidth 优化
- 相噪跟踪 (载波恢复)

### 6.2 I/Q 不平衡

| 不平衡类型 | EVM 贡献 |
|:----------|:--------:|
| 增益不平衡 0.5dB | ~0.5% |
| 相位不平衡 3° | ~1.0% |
| DC 偏置 -40dBc | ~1.0% |
| 三项叠加 | ~1.5% |

**缓解**: 数字 I/Q 校正 (Gram-Schmidt)

### 6.3 PA 非线性

| OBO (输出回退) | EVM (无DPD) | EVM (有DPD) |
|:--------------:|:----------:|:----------:|
| 6 dB | 6~8% | 1.5~2% |
| 8 dB | 4~6% | 1~1.5% |
| 10 dB | 2~3% | <1% |

### 6.4 带内平坦度

CFR/DPD/滤波器级联导致频域幅度波动 → EVM 恶化

**缓解**: DFE 内数字均衡器 (FIR 预补偿)

---

## 7. FPGA EVM 测试模块

### 7.1 EVM 计算模块

```verilog
module evm_calc #(
    parameter N_SYMBOLS = 1000  // 统计符号数
) (
    input  clk,
    input  rst_n,
    input  signed [15:0] ref_i, ref_q,   // 理想参考
    input  signed [15:0] meas_i, meas_q, // 测量值
    input  valid,
    output [31:0] evm_rms_q16,           // Q16 格式 EVM
    output [31:0] evm_peak_q16,
    output done
);

// 实现:
// 1. 误差: err = meas - ref (复差)
// 2. 误差功率: |err|^2
// 3. 参考功率: |ref|^2
// 4. 累积求和 (N_SYMBOLS 个)
// 5. 结束时输出 sqrt(Σ|err|^2 / Σ|ref|^2)

// 注意: CORDIC 做 sqrt 或查表
// 累加器位宽: 32bit (防溢出)
```

### 7.2 参数化测试平台

```matlab
% 自动化 EVM 测试
% 1. 配置 FPGA TM 类型 + 衰减
% 2. 触发回环测量
% 3. 读取 EVM 结果寄存器
% 4. 记录到测试日志

function run_evm_test()
    configs = {'TM1.1', 'TM2', 'TM2a'};
    atten   = [0, 10, 20, 30];  % dB
    
    for tm = configs
        for att = atten
            evm = measure_evm(tm{1}, att);
            fprintf('%s @ %ddB att: EVM=%.2f%%\n', tm{1}, att, evm);
        end
    end
end
```

---

## 8. 调试工具链

| 工具 | 用途 | 连接方式 |
|:----|:----|:---------|
| **Vivado ILA** | FPGA 内部信号捕获 | JTAG |
| **频谱仪** | RF 频谱/ACLR/EVM | RF 线缆 |
| **VSA (89600)** | 解调分析 | RF 线缆 |
| **MATLAB** | 离线数据分析 | ETH/串口 |
| **Python** | 产线自动化 | ETH (SCPI) |

**典型调试流程**:

```
频谱粗测 → 确认有信号 → ILA 抓数字逻辑 → MATLAB 分析 IQ → 定位问题
   (ACLR/EVM)      (信号功率/频率)     (数字处理链)       (星座/EVM per SC)
```
