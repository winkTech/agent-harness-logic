---
name: fixed-point-methodology
title: "定点量化方法论"
domain: algorithm
tags: [fixed-point, quantization, methodology]
created: 2026-06-14
updated: 2026-06-14
difficulty: advanced
applies_to: algorithm-engineer
---

# 定点量化方法论

> 算法工程师的核心工作流 — 从浮点 Golden Model 到 bit-true 定点模型。

---

## 1. 总体流程

```
浮点 Golden Model
     │
     ▼
[步骤 1] 动态范围分析
     │   └─ 扫描关键节点的幅值/方差/峰均比
     ▼
[步骤 2] 整数位宽确定
     │   └─ 统计 max/min + 3σ → 整数位宽 = ceil(log2(max(|x|))) + 1(符号)
     ▼
[步骤 3] 小数位宽扫描
     │   └─ 从 16bit→10bit 逐 bit 扫描 BER/EVM 退化
     ▼
[步骤 4] 截断/舍入策略对比
     │   └─ truncation / rounding / saturation / rounding+saturation
     ▼
[步骤 5] 溢出概率验证
     │   └─ 长序列仿真确认溢出率 < 1e-6
     ▼
[步骤 6] 输出定点方案
         └─ fixed_point_report.md + bit-true 定点模型
```

---

## 2. 按模块定点化原则

**[MUST] 逐模块定点化，不整体定点。**

```
❌ 错误做法：整体定点
   整个链路用同一 Q 格式 → 交叉误差无法定位

✅ 正确做法：逐模块定点
   Module A: Q2.14     ← 动态范围大，需要更多整数位
   Module B: Q1.15     ← 归一化信号
   Module C: Q4.12     ← 累加器需要保护位
```

**原因**：不同模块动态范围差异大（如 FFT 输出增益 vs 滤波器输出归一化），统一位宽要么浪费精度要么溢出。

---

## 3. 位宽确定方法

### 3.1 动态范围分析

```matlab
% 扫描各节点动态范围
signals = run_floating_point_simulation();
for node = keys(signals)
    s = signals(node);
    stats(node).max   = max(abs(s(:)));
    stats(node).mean  = mean(abs(s(:)));
    stats(node).sigma = std(s(:));
    stats(node).peak_to_avg = stats(node).max / stats(node).mean;
end
```

### 3.2 整数位宽 = ceil(log2(max)) + 1

| 信号类型 | 整数位宽规则 | 示例 |
|:---------|:-------------|:------|
| 归一化信号 | 符号 + 0 整数位 (Q1.N) | QPSK 调制输出 |
| 累加器 | 符号 + log2(累加次数) 整数保护位 | FIR 累加器 |
| FFT 输出 | 符号 + log2(N) 整数位 | 64 点 FFT → +6 bit |
| 反馈环路 | 额外 +1~2 bit 防止振荡发散 | 均衡器反馈 |

### 3.3 小数位宽 = 总位宽 − 整数位宽 − 1(符号)

在 [12bit, 18bit] 范围内扫描，观察 BER/EVM 退化曲线：

```
      BER vs 总位宽
    ┌─────────────────┐
    │ ░░▒▒▓▓████░░░░  │  14bit+: BER 平台期
    │ ░░▒▒████░░░░░░  │  12bit: 轻微退化 (<0.1dB)
    │ ░░████░░░░░░░░  │  10bit: 不可接受 (>0.5dB)
    └─────────────────┘
      10  12  14  16  18
          ↑
      推荐最低位宽
```

---

## 4. 截断/舍入策略

| 策略 | BER 影响 | LUT 代价 | 适用场景 |
|:-----|:---------|:---------|:---------|
| **truncation** | 最大（直流偏置） | 0 | 非关键路径，位宽充裕 |
| **rounding** | 中等 | +少量 LUT | 大多数场景 |
| **saturation** | 小 | +比较器 | 可能有溢出的节点 |
| **rounding+saturation** | 最小 ✅ 推荐 | +少量 LUT+比较器 | **所有关键节点** |

### 推荐策略

```verilog
// rounding + saturation 的 RTL 实现（供逻辑工程师参考）
wire [WIDTH:0] rounded = data + { {(WIDTH-1){1'b0}}, 1'b1 };  // +0.5 LSB
wire [WIDTH:0] saturated = (rounded[WIDTH] != rounded[WIDTH-1])
                         ? { ~rounded[WIDTH], {(WIDTH-1){rounded[WIDTH]}} }
                         : rounded;
assign result = saturated[WIDTH-1:0];
```

---

## 5. 溢出验证

**[MUST] 每节点溢出率 < 1e-6**

```matlab
function check_overflow(node_data, int_bits)
    max_val = 2^(int_bits - 1) - 1;   % 正最大
    min_val = -2^(int_bits - 1);      % 负最大
    overflow_rate = sum(abs(node_data) > max_val | node_data < min_val) / length(node_data);
    assert(overflow_rate < 1e-6, ...
        sprintf('Overflow rate %.2e exceeds 1e-6 at %s', overflow_rate, node_name));
end
```

---

## 6. 输出工件

| 工件 | 内容 | 消费者 |
|:-----|:-----|:--------|
| `fixed_point_report.md` | 位宽扫描结果 + 最终方案 | 算法工程师归档 |
| `fixed_point_config.m` | MATLAB 定点配置脚本 | 算法工程师自用 |
| `bit_width.yaml` | 模块级位宽表 | **逻辑工程师 RTL 编码** |

### bit_width.yaml 格式

```yaml
module: "fft_64"
ports:
  - name: "data_in"
    width: 16
    int_bits: 2
    frac_bits: 13
    signed: true
  - name: "data_out"
    width: 18
    int_bits: 4
    frac_bits: 13
    signed: true
internal_nodes:
  - name: "twiddle_mul"
    width: 18
    int_bits: 3
    frac_bits: 14
```

---

## 7. 精度验收标准

| 模块类型 | NMSE 要求 | BER 退化 | EVM 退化 |
|:---------|:----------|:---------|:---------|
| 标准模块（FIR/CRC/PRBS） | ≤ −40dB | < 0.1dB @ target SNR | < 0.5dB |
| 高安全模块（FFT/均衡器/Viterbi） | ≤ −50dB | < 0.05dB @ target SNR | < 0.2dB |
| 反馈环路 | ≤ −60dB | < 0.02dB | < 0.1dB |
