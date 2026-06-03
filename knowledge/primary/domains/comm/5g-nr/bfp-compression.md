# BFP 6bit 块浮点压缩解压算法

> 最后更新: 2026-06-03
> 关联: [[oran-interface]], [[lowphy-architecture]], [[nr-test-mode]]

---

## 1. 为什么需要 BFP 压缩

### 1.1 前传带宽瓶颈

ORAN 前传接口 (eCPRI) 传输 **频域 IQ 数据**:

- 100MHz NR, 4T4R, 每符号 4096 个复采样
- 每采样 16bit I + 16bit Q = 32bit
- 总带宽: 4096 × 32 × 14 (符号) × 10 (时隙/ms) = ~18.4 Gbps
- 加开销后超过 25GE 前传容量

**BFP 压缩** 将 16bit 压缩到 6bit → 压缩比 ~2.67:1，25GE 前传即可承载。

### 1.2 压缩位置

```
UL: FFT → 频域IQ → BFP压缩 → eCPRI → DU
DL: DU → eCPRI → BFP解压 → 频域IQ → IFFT
```

---

## 2. 算法原理

### 2.1 块浮点 (Block Floating Point)

**思想**: 一组数据 **共享指数**，每个元素只存尾数。

```
原始数据 (16bit 定点):
  [a0, a1, a2, ..., a_{N-1}]

块浮点表示:
  Exponent: E (共享)
  Mantissa: [m0, m1, m2, ..., m_{N-1}] (每位宽 B bit)
  
  a_i = m_i × 2^E
```

**与纯浮点区别**:
| 类型 | 指数 | 尾数 | 资源 |
|:----|:----|:----|:----|
| 纯浮点 (FP32) | 各元素独立 | 各元素独立 | 高 |
| 块浮点 (BFP) | 块内统一 | 各元素独立 | 低 |
| 定点 (Fixed) | 全局固定 | 各元素独立 | 最低 |

### 2.2 分块策略

```
N 个 IQ 采样
┌──────────┬──────────┬──────────┬──────────┐
│ Block 0  │ Block 1  │ ...      │ Block M-1│
│ (K采样)   │ (K采样)  │          │ (K采样)  │
└──────────┴──────────┴──────────┴──────────┘

每块: 1 个共享指数 E + K 个尾数 (B bit each)
```

**块大小选择**:

| K (块内采样数) | 压缩率 | 量化误差 | 适用场景 |
|:-------------:|:------:|:--------:|:--------|
| 4 | 低 | 优 | 高精度要求 |
| 8 | 中 | 良 | 默认配置 |
| 16 | 高 | 中 | 资源节省优先 |
| 32 | 很高 | 差 | 不推荐 |

ORAN 标准默认 **K=8**，即每块 8 个复采样 (16 个实数值)。

### 2.3 6bit BFP 格式

ORAN 标准定义 **BFP 6bit** 每元素:

```
Block Exponent (8bit) — 块内公共指数 (有符号, 2的补码)
Element 0: Mantissa[5:0]  (6bit I)
Element 0: Mantissa[5:0]  (6bit Q)
Element 1: ...
...
Element K-1: ...
```

**格式编码**:

```
原始: s[15:0] (16bit 有符号定点)
BFP:   m[5:0] = quantize(s[15:0] >> (E - correction))
       E = floor(log2(max(|s_i|))) + 1 + correction

其中:
  correction = 使 m 充分利用 6bit 范围的偏移 (Mantissa 归一化)
  max(|s_i|) 是块内所有采样绝对值最大值
```

---

## 3. 压缩流程 (UL)

### 3.1 编码步骤

对于每块 K 个 IQ 复采样 (I,Q 分离):

**Step 1: 找块内最大值**

$$M = \max_{i=0}^{K-1} (|I_i|, |Q_i|)$$

**Step 2: 计算指数**

$$E = \begin{cases} \lceil \log_2(M) \rceil, & M > 0 \\ 0, & M = 0 \end{cases}$$

**Step 3: 量化尾数**

$$m_i = \text{round}\left(\frac{s_i}{2^{E-B+1}}\right), \quad \text{clamp to } [-2^{B-1}, 2^{B-1}-1]$$

其中 B=6, 尾数范围 [-32, 31]

**Step 4: 打包**

```
| Exponent (8bit) | m0_I(6) | m0_Q(6) | m1_I(6) | m1_Q(6) | ... | m7_I(6) | m7_Q(6) |
```

K=8 时: 8 + 16×6 = 104 bit (原始: 16×32=512 bit), 压缩比 4.92:1

### 3.2 实现 (MATLAB 原型)

```matlab
function [exp_val, mantissa] = bfp_encode_fixed(input, block_size, B)
    % input: 1×N 定点数组 (int16)
    % block_size: 块大小 (默认 16 个实值 = 8 个复采样)
    % B: 尾数位宽 (默认 6)
    
    N = length(input);
    num_blocks = ceil(N / block_size);
    exp_val = zeros(1, num_blocks, 'int8');
    mantissa = zeros(1, N, 'int8');
    
    for blk = 1:num_blocks
        idx = (blk-1)*block_size + 1 : min(blk*block_size, N);
        block = input(idx);
        
        % Step 1: 找块内最大值
        M = max(abs(double(block)));
        
        % Step 2: 计算指数
        if M == 0
            exp_val(blk) = 0;
            mantissa(idx) = 0;
        else
            E = ceil(log2(M));
            exp_val(blk) = int8(E);
            
            % Step 3: 量化尾数
            scale = 2^(E - B + 1);
            m = round(double(block) / scale);
            m = max(min(m, 2^(B-1)-1), -2^(B-1)); % clamp
            mantissa(idx) = int8(m);
        end
    end
end
```

---

## 4. 解压流程 (DL)

### 4.1 解码

$$s_{recon}(i) = m_i \times 2^{E - B + 1}$$

```matlab
function output = bfp_decode(exp_val, mantissa, block_size, B)
    N = length(mantissa);
    output = zeros(1, N, 'int16');
    
    for blk = 1:length(exp_val)
        idx = (blk-1)*block_size + 1 : min(blk*block_size, N);
        scale = 2^(double(exp_val(blk)) - B + 1);
        output(idx) = int16(double(mantissa(idx)) * scale);
    end
end
```

### 4.2 量化误差分析

使用 **SQNR (Signal-to-Quantization-Noise Ratio)** 评估:

$$SQNR = 6.02 \times B + 4.77 - P APR_{dB} \text{ (dB)}$$

| B (bit) | SQNR (PAPR=10dB) | EVM 等效 |
|:-------:|:----------------:|:--------:|
| 4 | 18.85 dB | ~11% |
| 5 | 24.87 dB | ~5.7% |
| 6 | 30.89 dB | ~2.9% |
| 8 | 42.93 dB | ~0.7% |
| 16 | 91.1 dB | — (不动) |

**B=6 时** EVM ~2.9%，满足 256QAM 解调需求 (<3.5%)。

---

## 5. FPGA 实现

### 5.1 BFP 编码器 (UL 压缩)

```verilog
module bfp_encoder #(
    parameter BLOCK_SIZE = 16,   // 每个块实值数 (=8个复采样)
    parameter B = 6              // 尾数位宽
) (
    input  clk,
    input  rst_n,
    input  signed [15:0] data_i,  // I/Q 采样输入
    input  valid,
    output reg [7:0]  exp_out,
    output reg [5:0]  mant_out,
    output reg        ready,
    output reg        block_done
);

// 实现思路:
// 1. 串行输入，每时钟 1 个采样
// 2. Block 内找最大值: 绝对值比较器 + 流水线
// 3. 块结束时计算指数 + 量化
// 4. 下一周期输出所有尾数

// 核心技术:
// - 找 |max|: 流水线比较器树
// - ceil(log2): Leading-One-Detector (LOD)
// - 除法 (移位): s_i >> (E-B+1)
// - round: +1/2 LSB

endmodule
```

### 5.2 BFP 解码器 (DL 解压)

```verilog
module bfp_decoder #(
    parameter BLOCK_SIZE = 16,
    parameter B = 6
) (
    input  clk,
    input  [7:0]  exp_in,
    input  [5:0]  mant_in,
    input  valid,
    output signed [15:0] data_out,
    output reg ready
);

// 实现: mantissa × 2^(exp - B + 1)
// = mantissa << (exp - B + 1)  (当 exp >= B-1)
// = mantissa >> (B - 1 - exp)  (当 exp < B-1)
//
// 考虑算术移位 (preserve sign)

// 注意: 乘法的精度损失 (去量化噪声)
// 建议加 dither 或噪声整形改善 EVM

endmodule
```

### 5.3 流水线设计

```
UL 编码流水线:
  [valid] → |·| → max_pipe → E_calc → quantize → pack
              clk1  clk2~K     clk3      clk4     clk5

DL 解码流水线:
  [valid] → unpack → shift → clamp → out
               clk1    clk2    clk3   clk4
```

### 5.4 关键优化

1. **浮点 LOD (Leading One Detector)**:
   ```verilog
   // 找绝对值最高位位置 (用于指数计算)
   always_comb begin
       if (abs_val[15]) lod = 15;
       else if (abs_val[14]) lod = 14;
       // ...
   end
   ```

2. **Round 实现**:
   ```verilog
   // 截断 + 补 1/2 LSB
   round_bit = (shift_out[B-2] & |shift_out[B-3:0]) ? 1 : 0;  // 向最近偶
   // 或简单 +0.5
   round_bit = shift_out[B-2];
   ```

3. **特殊值处理**:
   - 全零块 → exp=0, 尾数全零 (提前退出)
   - 饱和 → 尾数 clamp 到 [-32, 31]

---

## 6. ORAN BFP 标准细节

### 6.1 块划分规则

- 实值 (I/Q 分离) 在同一块内
- 块大小 K=16 个实值 = 8 个复采样
- ORAN C-plane 中 udCompHdr 字段定义压缩方式

### 6.2 udCompHdr 字段

```
udCompHdr[7:4] = 压缩方法 (0: BFP, 1: 块缩放, 2~15: 预留)
udCompHdr[3:0] = 尾数位宽 - 1 (B=6 → 0101b)
```

### 6.3 多天线压缩

```
4T4R 同符号:
  Ant0: Block0_Ant0, Block1_Ant0, ...
  Ant1: Block0_Ant1, Block1_Ant1, ...
  ...
  
每天线独立 BFP (指数独立) → 压缩效率 vs 精度平衡
```

---

## 7. 性能测试

### 7.1 测试向量

| 场景 | 信号类型 | 期望 SQNR | 期望 EVM |
|:----|:---------|:---------:|:--------:|
| QPSK | 均匀分布 | >30 dB | <3% |
| 16QAM | 多幅度 | >30 dB | <3% |
| 64QAM | 多幅度 | >30 dB | <3% |
| 256QAM | 密集幅度 | >30 dB | <3% (256QAM 要求 <3.5%) |
| OFDM (PAPR ~10dB) | 类高斯 | >28 dB | <4% |

### 7.2 EVM 恶化源

```
原始信号 → BFP 压缩 → BFP 解压 → 解调 EVM

EVM 分配:
  BFP 量化: ~1.5%
  相位噪声: ~1.0%
  PA 非线性: ~2.0%
  ADC/DAC: ~1.0%
  ---
  合计: ~3.2% (满足 256QAM 3.5% 要求)
```

### 7.3 MATLAB 验证

```matlab
% BFP 压缩验证
% 生成 OFDM 信号
tx_signal = generate_nr_ofdm(100e6, 4096);
tx_signal_int = sfi(tx_signal, 16, 15);

% BFP 压缩
[exp_val, mant] = bfp_encode_fixed(tx_signal_int.data, 16, 6);

% BFP 解压
rx_signal_int = bfp_decode(exp_val, mant, 16, 6);

% EVM 计算
evm = calc_evm(double(tx_signal_int), double(rx_signal_int));
fprintf('BFP(6bit) EVM = %.2f %%\n', evm * 100);
```
