---
title: "卷积编码与 Viterbi 译码 — 算法规范"
domain: comm
tags: [convolutional-code, viterbi, fec, channel-coding, algorithm]
created: 2026-06-14
updated: 2026-06-14
difficulty: advanced
applies_to: algorithm-engineer
---

# 卷积编码与 Viterbi 译码

> 通信系统中前向纠错 (FEC) 的核心技术之一。本文覆盖从数学原理到定点实现的全链路。

---

## 1. 总体概览

```
发送端                              接收端
Tx Data ──→ [卷积编码器] ──→ 调制 ─→ 信道 ─→ 解调 ──→ [Viterbi译码器] ──→ Rx Data
                │                                            │
          编码参数: K, rate, poly                       译码参数: 软/硬判决, TB深度
```

| 参数 | 典型值 | 说明 |
|:-----|:--------|:------|
| 约束长度 K | 7 (64 states) | 最常用，DVB/802.11/LTE 标准 |
| 编码速率 rate | 1/2, 2/3, 3/4, 5/6 | 通过删余 (puncturing) 实现 |
| 生成多项式 | G1=171₈, G2=133₈ | K=7 标准多项式 (octal) |
| 译码算法 | Viterbi (MLSE) | 最大似然序列估计 |
| 判决方式 | 软判决 (3~4bit) | 比硬判决好 ~2dB 编码增益 |

---

## 2. 卷积编码器

### 2.1 编码器结构

卷积编码器由 K-1 级移位寄存器和模 2 加法器组成：

```
          ┌─────────────────────────────────────────┐
          │         ┌───┐    ┌───┐        ┌───┐     │
    x[n] ─┼─→┤D├─→┤D├─→ ... ─→┤D├─→      │
          │         └───┘    └───┘        └───┘     │
          │           │        │   ...      │        │
          │           ├────────┴───────────┤        │
          │           │        │           │        │
          │          ┌▼────────▼───────────▼┐       │
          │          │      G1多项式        │       │
          │          │   (如 171₈ = 1 1_1_1 0 0_1) │
          │          └────────┬─────────────┘       │
          │                   │ y1[n]               │
          │          ┌────────▼─────────────┐       │
          │          │      G2多项式        │       │
          │          │   (如 133₈ = 1 0_1_1 0 1_1) │
          │          └────────┬─────────────┘       │
          │                   │ y2[n]               │
          └───────────────────┴─────────────────────┘
```

### 2.2 生成多项式

K=7, rate=1/2 的 LTE/DVB 标准多项式：

| 输出 | 八进制 | 二进制 (从 MSB→LSB) | 对应抽头 |
|:-----|:-------|:--------------------|:---------|
| G1 | 171₈ | 1 1 1 1 0 0 1 | 1,2,3,4,7 |
| G2 | 133₈ | 1 0 1 1 0 1 1 | 1,3,4,6,7 |

```matlab
% 多项式定义（K=7）
G1 = bin2dec('1111001');  % 171 octal
G2 = bin2dec('1011011');  % 133 octal

% 重要：移位寄存器初始化为 0，输入从 MSB 进入
% 第 1 位对应 x[n-1]（最左），第 7 位对应 x[n-6]（最右）
```

### 2.3 编码方程

```
y1[n] = x[n] ⊕ x[n-1] ⊕ x[n-2] ⊕ x[n-3] ⊕ x[n-6]     (G1 = 1111001)
y2[n] = x[n] ⊕ x[n-2] ⊕ x[n-3] ⊕ x[n-5] ⊕ x[n-6]     (G2 = 1011011)
```

### 2.4 编码器状态定义

状态 = 移位寄存器的内容（不含当前输入 x[n]）：

```
state[n] = { x[n-1], x[n-2], ..., x[n-K+1] }   % K-1 bit

对于 K=7: state = {x[n-1], x[n-2], x[n-3], x[n-4], x[n-5], x[n-6]}
共 2^(K-1) = 64 个状态，编号 0~63
```

### 2.5 收尾 (Termination)

**[MUST] 每帧编码结束时，必须将编码器回归零状态：**

```matlab
function [output, tail] = conv_encoder_terminate(input, K)
    % 输入：input - 信息比特 (1×N)
    % 输出: output - 编码比特, tail - 收尾比特

    % 1. 正常编码 N 个信息比特
    output = conv_encode(input, K);

    % 2. 收尾：输入 (K-1) 个 0 将状态清零
    tail_bits = zeros(1, K-1);
    tail = conv_encode(tail_bits, K);  % 产生 2×(K-1) 个收尾比特

    % 3. 注意：Viterbi 译码器需要知道收尾位置来终止 traceback
end
```

收尾产生额外的 `rate × (K-1)` 个比特。LTE 标准中收尾比特用于帮助译码器确定帧边界。

### 2.6 删余 (Puncturing) — 实现更高码率

母码 rate=1/2 → 通过删余得到 2/3, 3/4, 5/6, 7/8：

| 目标码率 | 删余图案 (Puncture Pattern) | 每 6 个母码输出保留 |
|:---------|:----------------------------|:--------------------|
| 1/2 | [1, 1] | 全部保留 |
| 2/3 | [1, 0; 1, 1] | 每 4 个保留 3 个 |
| 3/4 | [1, 0; 1, 1; 0, 1] | 每 6 个保留 4 个 |
| 5/6 | [1, 0; 1, 0; 1, 0; 1, 1; 0, 1] | 每 10 个保留 6 个 |
| 7/8 | [1, 0; 1, 0; 1, 0; 1, 0; 1, 0; 1, 1; 0, 1] | 每 14 个保留 8 个 |

```matlab
function y = puncture(y_mother, rate)
    switch rate
        case 1/2, pattern = [1 1];
        case 2/3, pattern = [1 1; 1 0];
        case 3/4, pattern = [1 1; 1 0; 0 1];
        case 5/6, pattern = [1 1; 1 0; 1 0; 0 1; 0 1];
        case 7/8, pattern = [1 1; 1 0; 1 0; 1 0; 0 1; 1 0; 0 1];
    end
    % y_mother: [2×N] 矩阵，第一行 y1, 第二行 y2
    % 按列扫描 pattern，0=删除，1=保留
    idx = find(pattern);
    y = y_mother(idx);
end
```

---

## 3. Viterbi 译码算法

### 3.1 算法概述

Viterbi 算法 = **最大似然序列估计 (MLSE)**，在网格图 (Trellis) 上搜索最小距离路径。

```
输入: 接收软比特序列 r[n]
输出: 最大似然信息序列 u_hat[n]

算法步骤（每时刻 n）:
  Step 1: BMU — 计算分支度量 Branch Metric（接收值 vs 理想值）
  Step 2: ACS — 每状态: Add(旧PM+BM) → Compare(两条路径) → Select(较小者)
  Step 3: SMU — 存储幸存路径 (Survivor Path)
  Step 4: TB  — 帧结束时回溯 (Traceback) 输出译码比特
```

### 3.2 网格图 (Trellis)

```
时刻 n-1          时刻 n            时刻 n+1
  0 ─────────▶ 0 ─────────▶ 0
   \            \            \
    \ 0→1       \ 0→1        \
     \            \            \
  1 ─────────▶ 1 ─────────▶ 1    ← 实线: 输入 0
   \            \                 ← 虚线: 输入 1
    \            \
  2 ─────────▶ 2 ─────────▶ 2
   ...          ...          ...

每状态有 2 条入边和 2 条出边（rate 1/2）
```

### 3.3 分支度量 (Branch Metric, BM)

**[MUST] 区分硬判决与软判决：**

#### 硬判决 (Hard Decision)

```matlab
function bm = branch_metric_hard(rx_bits, ideal_bits)
    % rx_bits:  接收硬判决比特 {0,1}
    % ideal_bits: 理想编码输出 {0,1}
    % bm: Hamming 距离（整数 0~2）
    bm = sum(xor(rx_bits, ideal_bits));
end
```

#### 软判决 (Soft Decision) — 推荐

```matlab
function bm = branch_metric_soft(rx_soft, ideal)
    % rx_soft: 接收软比特（如 3bit signed, 范围 -7~+7）
    % ideal:   理想值 {+1, -1}
    % bm: Euclidean 距离
    bm = sum((rx_soft - ideal) .^ 2);
    % 或简化: bm = -sum(rx_soft .* ideal)  % 相关度量
end
```

**软判决 vs 硬判决增益**：

| 判决方式 | 编码增益 (相对未编码 BPSK @ BER=1e-5) | 实现代价 |
|:---------|:--------------------------------------|:---------|
| 未编码 | 0 dB | — |
| 硬判决 Viterbi | ~3.5 dB | 1bit 量化 |
| 3bit 软判决 Viterbi | ~5.2 dB (+1.7dB 增益) | 3bit 量化器 |
| 4bit 软判决 Viterbi | ~5.5 dB (+0.3dB) | 4bit 量化器（收益递减） |

**推荐：3bit 软判决** — 性能/面积最佳平衡点。

### 3.4 加-比-选 (ACS)

```matlab
function [pm_new, decision] = acs(pm_old, bm_0, bm_1)
    % 每个状态执行 ACS
    % pm_old(2): 前一级两个前驱状态的路径度量
    % bm_0, bm_1: 对应的分支度量
    % pm_new: 本级路径度量（选较小者）
    % decision: 0=选上分支, 1=选下分支

    path0 = pm_old(1) + bm_0;
    path1 = pm_old(2) + bm_1;

    if path0 <= path1
        pm_new = path0;
        decision = 0;
    else
        pm_new = path1;
        decision = 1;
    end
end
```

### 3.5 路径度量归一化 (PM Normalization)

**[MUST] 路径度量无界增长处理：**

```matlab
function pm = normalize_path_metrics(pm, N_states)
    % 方法 1: 减去最小值（最常用）
    pm = pm - min(pm);
    % 所有 PM 减去最小值，保证 PM ≥ 0

    % 方法 2: 模归一化 (用于硬件)
    % 要求 PM 位宽足够，检测 MSB 翻转
    if max(pm) > PM_THRESHOLD
        pm = pm - PM_OFFSET;
    end
end
```

**定点实现注意**：PM 位宽取决于约束长度 K 和帧长 N。

```matlab
% PM 位宽估算
K = 7;                   % 约束长度
max_bm = 2 * (2^Q-1)^2; % 每时刻最大 BM（软判决 Q bit）
N = 1024;                % 帧长
pm_bits = ceil(log2(N * max_bm)) + 1;  % +1 符号位
% Q=3bit, K=7, N=1024 → ~19 bit
```

### 3.6 回溯 (Traceback, TB)

**[MUST] 回溯深度选择：**

```matlab
function decoded = traceback(survivor_mem, tb_depth, decision)
    % survivor_mem: (N_states × N) 决策矩阵
    % tb_depth: 回溯深度 (一般取 5×K ~ 10×K)
    % decision: 最后一个状态的决策路径

    % 1. 从最后时刻的状态 0 开始回溯（收尾保证归零）
    state = 0;
    decoded = zeros(1, tb_depth);

    for i = tb_depth:-1:1
        % 读决策比特: 0=上分支(输入0), 1=下分支(输入1)
        dec = survivor_mem(state + 1, end - tb_depth + i);
        decoded(i) = dec;

        % 回溯到前驱状态
        state = prev_state(state, dec, K);
    end
end
```

**回溯深度建议**：

| K | 最小 TB 深度 | 推荐 TB 深度 | BER 接近 ML 损失 |
|:--|:-------------|:------------|:-----------------|
| 3 | 15 | 20 | <0.05 dB |
| 5 | 25 | 35 | <0.05 dB |
| **7** | **35** | **50~64** | **<0.05 dB** |
| 9 | 45 | 64 | <0.05 dB |

---

## 4. 定点量化指南

### 4.1 接收软比特量化

```
模数转换 → AGC → Q 位软判决 → Viterbi 译码器
```

| Q (位宽) | 范围 | 编码增益损失 | 推荐场景 |
|:---------|:-----|:-------------|:---------|
| 1 (硬判决) | {0,1} | 0 dB (基准) | 面积极度受限 |
| 3 (推荐) | -7~+7 | +1.7 dB | **最佳折中** |
| 4 | -15~+15 | +2.0 dB | 性能极致要求 |
| 5+ | -31~+31 | +2.1 dB | 收益递减 |

**量化方法**：

```matlab
function rx_soft = quantize_soft(rx_float, Q)
    % rx_float: 浮点接收信号（BPSK: ±1 + 噪声）
    % Q: 量化位数 (不含符号位: 总位宽 = Q+1)
    max_val = 2^Q - 1;
    % 饱和量化
    rx_soft = round(rx_float * max_val);
    rx_soft = max(-max_val, min(max_val, rx_soft));
    % 输出 Q+1 bit signed
end
```

### 4.2 分支度量位宽

| Q | BM 最大理论值 | 推荐 BM 位宽 |
|:--|:--------------|:-------------|
| 3 | 2 × (2×7)² = 392 | 9 bit (signed) |
| 4 | 2 × (2×15)² = 1800 | 11 bit (signed) |

### 4.3 路径度量位宽

| 参数 | N=512 | N=1024 | N=2048 |
|:-----|:------|:-------|:--------|
| K=7, Q=3 | 17 bit | 18 bit | 19 bit |
| K=7, Q=4 | 19 bit | 20 bit | 21 bit |
| K=9, Q=3 | 18 bit | 19 bit | 20 bit |

**经验公式**：`PM_bits = ceil(log2(N × 2 × (2^Q-1)^2)) + 2`

### 4.4 定点精度要求

| 节点 | 浮点退化容忍度 | 说明 |
|:-----|:--------------|:------|
| 软判决量化 | < 0.1 dB @ BER=1e-5 | Q ≥ 3 时满足 |
| 路径度量截断 | < 0.05 dB | PM 位宽 ≥ 公式值 |
| 归一化偏置 | < 0.02 dB | 减最小值为准 |

---

## 5. Golden Model (MATLAB)

### 5.1 编码器 Golden Model

```matlab
function y = conv_encoder_golden(x, K, g1, g2)
% 卷积编码器 Golden Model
% 输入:
%   x   - 信息比特 (1×N), {0,1}
%   K   - 约束长度 (默认 7)
%   g1  - G1 多项式 (octal, 默认 171)
%   g2  - G2 多项式 (octal, 默认 133)
% 输出:
%   y   - 编码比特 (1×2N), {0,1}

    if nargin < 2, K = 7; end
    if nargin < 3, g1 = oct2dec(171); end
    if nargin < 4, g2 = oct2dec(133); end

    % 移位寄存器初始化
    shift_reg = zeros(1, K-1);
    N = length(x);
    y = zeros(1, 2*N);
    idx = 1;

    for n = 1:N
        in = x(n);
        % G1: 多项式掩码 (MSB=最左抽头)
        y1 = xor(in, shift_reg(1) & bitget(g1, K-1));
        for i = 2:K-1
            if bitget(g1, K-i)
                y1 = xor(y1, shift_reg(i));
            end
        end
        % G2: 类似
        y2 = xor(in, shift_reg(1) & bitget(g2, K-1));
        for i = 2:K-1
            if bitget(g2, K-i)
                y2 = xor(y2, shift_reg(i));
            end
        end
        y(idx:idx+1) = [y1, y2];
        idx = idx + 2;

        % 移位寄存器更新
        shift_reg = [in, shift_reg(1:end-1)];
    end
end
```

**简化版（利用 poly2trellis）**：

```matlab
function y = conv_encoder_golden_simple(x)
    % LTE K=7, rate=1/2
    trellis = poly2trellis(7, [171 133]);
    y = convenc(x, trellis);
    % convenc 自动处理收尾（若需要零尾）
    % y = convenc(x, trellis, 0);  % 0 = 收尾到零状态
end
```

### 5.2 Viterbi 译码器 Golden Model

```matlab
function u_hat = viterbi_decoder_golden(y, K, g1, g2, decision, tb_depth)
% Viterbi 译码器 Golden Model（硬判决）
% 输入:
%   y        - 接收编码比特 {0,1}
%   K        - 约束长度
%   decision - 0=硬判决, 1=软判决
%   tb_depth - 回溯深度
% 输出:
%   u_hat    - 译码信息比特

    if nargin < 2, K = 7; end
    if nargin < 3, g1 = oct2dec(171); end
    if nargin < 4, g2 = oct2dec(133); end
    if nargin < 5, decision = 0; end
    if nargin < 6, tb_depth = 5*K; end

    N_states = 2^(K-1);
    N = length(y) / 2;

    % 网格图生成
    [next_state, output] = generate_trellis(K, g1, g2);

    % 初始化路径度量
    pm = inf(1, N_states);
    pm(1) = 0;  % 从零状态开始

    % 幸存路径存储
    surv = zeros(N_states, N);

    % ── 前向: ACS ──
    for n = 1:N
        rx_bits = y(2*n-1:2*n);
        new_pm = inf(1, N_states);

        for state = 0:N_states-1
            if isinf(pm(state+1)), continue; end

            % 两条出边: 输入 0 和 1
            for inp = 0:1
                ns = next_state(state+1, inp+1);
                ideal = output(state+1, inp+1, :);

                % 分支度量 (Hamming)
                bm = sum(xor(rx_bits, [ideal(1), ideal(2)]));

                % ACS
                candidate = pm(state+1) + bm;
                if candidate < new_pm(ns+1)
                    new_pm(ns+1) = candidate;
                    surv(ns+1, n) = inp;
                end
            end
        end

        % 归一化
        pm = new_pm - min(new_pm);
    end

    % ── 回溯 ──
    state = 0;  % 从零状态回溯（收尾保证）
    u_hat = zeros(1, N);
    start = max(1, N - tb_depth + 1);
    for n = N:-1:start
        inp = surv(state+1, n);
        u_hat(n) = inp;
        state = next_state_inv(state, inp, K);
    end
    u_hat = u_hat(start:end);
end

function [next_state, output] = generate_trellis(K, g1, g2)
    N_states = 2^(K-1);
    next_state = zeros(N_states, 2);
    output = zeros(N_states, 2, 2);

    for state = 0:N_states-1
        for inp = 0:1
            % 新状态 = {inp, state[0:K-2]}
            ns = bitshift(state, -1) + inp * 2^(K-2);
            next_state(state+1, inp+1) = ns;

            % 编码输出
            sr = [inp, bitget(state, K-1:-1:1)];
            y1 = mod(sum(sr & bitget(g1, K:-1:1)), 2);
            y2 = mod(sum(sr & bitget(g2, K:-1:1)), 2);
            output(state+1, inp+1, :) = [y1, y2];
        end
    end
end
```

### 5.3 软判决 Viterbi

```matlab
function u_hat = viterbi_soft_golden(rx_soft, K, g1, g2, Q, tb_depth)
% 软判决 Viterbi 译码器
% 输入:
%   rx_soft  - 软比特序列 (Q+1 bit signed, 范围 -(2^Q-1)~+(2^Q-1))
%   Q        - 量化位数

    if nargin < 3, g1 = oct2dec(171); end
    if nargin < 4, g2 = oct2dec(133); end
    if nargin < 5, Q = 3; end
    if nargin < 6, tb_depth = 5*K; end

    N_states = 2^(K-1);
    N = length(rx_soft) / 2;

    [next_state, output] = generate_trellis(K, g1, g2);

    % 欧几里得距离分支度量
    % 将 {0,1} 映射为 {+1, -1} 便于距离计算
    ideal_map = [1, -1];

    pm = zeros(1, N_states) * 1e6;
    pm(1) = 0;
    surv = zeros(N_states, N);

    for n = 1:N
        rx = rx_soft(2*n-1:2*n);
        new_pm = zeros(1, N_states) * 1e6;

        for state = 0:N_states-1
            if pm(state+1) > 1e5, continue; end

            for inp = 0:1
                ns = next_state(state+1, inp+1);
                ideal0 = ideal_map(output(state+1, inp+1, 1) + 1);
                ideal1 = ideal_map(output(state+1, inp+1, 2) + 1);

                % 欧几里得距离平方
                bm = (rx(1) - ideal0)^2 + (rx(2) - ideal1)^2;

                % 或使用相关度量（硬件更常用）:
                % bm = -(rx(1)*ideal0 + rx(2)*ideal1);

                candidate = pm(state+1) + bm;
                if candidate < new_pm(ns+1)
                    new_pm(ns+1) = candidate;
                    surv(ns+1, n) = inp;
                end
            end
        end

        pm = new_pm - min(new_pm);
    end

    % 回溯（同硬判决）
    state = 0;
    u_hat = zeros(1, N);
    for n = N:-1:max(1, N-tb_depth+1)
        inp = surv(state+1, n);
        u_hat(n) = inp;
        % 前驱状态计算
        state = bitshift(state, 1) + inp;
        if bitget(state, K)  % 超过 K-1 bit
            state = bitxor(state, 2^(K-1));
        end
    end
end
```

---

## 6. 性能分析

### 6.1 BER 仿真方法

```matlab
function [ber, bits] = viterbi_ber_sim(EbN0_dB, K, rate, frame_len, num_frames)
% EbN0_dB: Eb/N0 仿真点 (dB)
% K: 约束长度
% rate: 编码码率 (1/2, 2/3, ...)

    trellis = poly2trellis(K, [171 133]);
    M = 2;  % BPSK
    code_rate = rate;

    total_bits = 0;
    total_errors = 0;

    for frame = 1:num_frames
        % 生成随机信息比特
        data = randi([0 1], 1, frame_len);

        % 编码
        coded = convenc(data, trellis, 0);  % 零尾收尾

        % 删余（若码率 > 1/2）
        if rate > 1/2
            coded = puncture(coded, rate);
        end

        % BPSK 调制
        tx = 1 - 2*coded;

        % AWGN 信道
        snr = EbN0_dB + 10*log10(code_rate) + 10*log10(2);  % BPSK
        rx = awgn(tx, snr, 'measured');

        % 硬判决解调
        rx_hard = rx < 0;

        % 解删余
        if rate > 1/2
            rx_hard = depuncture(rx_hard, rate, frame_len);
        end

        % Viterbi 译码
        decoded = vitdec(rx_hard, trellis, 5*K, 'trunc', 'hard');

        % 统计
        errs = sum(data ~= decoded);
        total_errors = total_errors + errs;
        total_bits = total_bits + frame_len;
    end

    ber = total_errors / total_bits;
    bits = total_bits;
end
```

### 6.2 典型性能曲线

```
K=7, rate=1/2, BPSK, AWGN 信道

Eb/N0 (dB)  硬判决 BER     软判决 BER (Q=3)  未编码 BER
─────────────────────────────────────────────────────────
0.0          1.2e-1         8.5e-2            1.6e-1
1.0          5.0e-2         2.8e-2            1.3e-1
2.0          1.5e-2         5.0e-3            8.5e-2
3.0          3.0e-3         5.0e-4            4.5e-2
4.0          3.5e-4         3.0e-5            —
4.5          1.0e-4         5.0e-6            —
5.0          —              5.0e-7            —
─────────────────────────────────────────────────────────
编码增益 @ BER=1e-5: 硬判决 ~3.5dB, 软判决 ~5.2dB
```

### 6.3 编码增益预期

| 码率 | K=7 硬判决 (dB) | K=7 软判决 Q=3 (dB) | 理论限 (dB) |
|:-----|:----------------|:--------------------|:------------|
| 1/2 | 3.5 | 5.2 | 7.0 |
| 2/3 | 2.8 | 4.5 | 5.5 |
| 3/4 | 2.3 | 3.8 | 4.8 |
| 5/6 | 1.8 | 3.0 | 4.0 |

---

## 7. 测试向量生成

### 7.1 Known Answer Test (KAT)

```matlab
function gen_viterbi_test_vectors()
    % 生成 Viterbi 译码器测试向量

    % ── Test 1: 全零输入 ──
    data1 = zeros(1, 100);
    [tv1_in, tv1_golden] = conv_encoder_golden(data1);
    save_hex('viterbi_tv1_in.hex', tv1_in, 1);
    save_hex('viterbi_tv1_golden.hex', tv1_golden, 1);

    % ── Test 2: 全 1 输入 ──
    data2 = ones(1, 100);
    [tv2_in, tv2_golden] = conv_encoder_golden(data2);
    save_hex('viterbi_tv2_in.hex', tv2_in, 1);
    save_hex('viterbi_tv2_golden.hex', tv2_golden, 1);

    % ── Test 3: 最差距离路径 ──
    data3 = [1, zeros(1, 99)];
    [tv3_in, tv3_golden] = conv_encoder_golden(data3);
    save_hex('viterbi_tv3_in.hex', tv3_in, 1);
    save_hex('viterbi_tv3_golden.hex', tv3_golden, 1);

    % ── Test 4: 长随机序列 + 软判决 ──
    rng(42);
    data4 = randi([0 1], 1, 1000);
    [tv4_in, tv4_golden] = conv_encoder_golden(data4);

    % 加性噪声 + 软判决量化
    tx = 1 - 2*tv4_golden;
    rx = awgn(tx, 4, 'measured');
    rx_quant = quantize_soft(rx, 3);

    save_hex('viterbi_tv4_in.hex', tv4_in, 1);
    save_csv('viterbi_tv4_soft.csv', rx_quant);

    % ── Test 5: 脉冲噪声 ──
    data5 = randi([0 1], 1, 100);
    [~, tv5_golden] = conv_encoder_golden(data5);
    tx5 = 1 - 2*tv5_golden;
    rx5 = tx5;
    rx5(50:60) = -rx5(50:60);  % 脉冲干扰
    save_csv('viterbi_tv5_burst.csv', rx5);

    disp('测试向量生成完成');
end
```

### 7.2 corner case 覆盖

| 场景 | 输入 | 验证目标 |
|:-----|:------|:---------|
| 全零 | 100b 全 0 | 编码器阶跃响应 |
| 全一 | 100b 全 1 | 编码器初始瞬态 |
| 孤立 1 | [1, 0×99] | 单脉冲响应 |
| 孤立 0 | [0, 1×99] | 校验码型 |
| 最差路径 | 使自由距离路径 | 译码器纠错极限 |
| 长随机 | 1000b 随机 | 长期统计一致性 |
| 脉冲噪声 | 随机+局部翻转 | 译码器抗突发 |

---

## 8. 常见问题与排查

### 8.1 编码器 — 译码器不匹配

| 症状 | 可能原因 | 排查 |
|:-----|:---------|:------|
| BER ~0.5 | 多项式顺序反了 | 检查 G1/G2 是否匹配标准 |
| 译码输出为镜面 | 回溯方向错误 | 检查 trellis 生成的方向性 |
| 帧首译码错误多 | 初始状态不为 0 | 确保编码器从零状态开始 |
| 帧尾译码错误多 | 收尾没对齐 | 检查 termination 长度 |
| 量化损失 >0.5dB | 软判决位宽不够 | Q 从 3 加到 4 试 |

### 8.2 硬件实现

| 问题 | 原因 | 修复 |
|:-----|:------|:------|
| ACS 溢出 | PM 位宽不足 | 用公式 `ceil(log2(N×BM_max))+2` |
| 路径度量饱和 | 归一化频率不够 | 每时刻归一化或减 min |
| 回溯错误 | TB 深度不够 | K=7 时 TB ≥ 50 |
| 资源超大 | 并型 ACS 太多 | 改用 2~4 路并型或串型 ACS |

---

## 9. 关键参数速查表

### K=7, rate=1/2 (LTE/DVB/802.11)

| 参数 | 值 |
|:-----|:----|
| 约束长度 K | 7 |
| 状态数 | 64 |
| 生成多项式 (octal) | G1=171, G2=133 |
| 自由距离 d_free | 10 |
| 编码增益 @ BER=1e-5 (硬判决) | ~3.5 dB |
| 编码增益 @ BER=1e-5 (软判决 Q=3) | ~5.2 dB |
| 软判决位宽 Q | 3 bit (推荐) |
| PM 位宽 (N=1024) | 18 bit |
| 回溯深度 TB | 50~64 |

### 常用多项式

| 标准 | K | 多项式 (octal) | 应用 |
|:-----|:---|:--------------|:------|
| LTE/DVB/802.11 | 7 | G1=171, G2=133 | **最通用** |
| LTE (速率匹配) | 7 | G1=133, G2=171 | 交替输出顺序 |
| GSM | 5 | G1=53, G2=75 | 约束长度较小 |
| 深空 (NASA) | 7 | G1=171, G2=133, G3=165 | 1/3 码率 |
| 深空 (NASA) | 9 | G1=753, G2=561 | 高增益 |

---

## 10. 验收标准

| 检查项 | 要求 |
|:-------|:------|
| 编码器 Golden vs 标准 | 输出与 `poly2trellis` + `convenc` 完全一致 |
| 译码器 Golden vs 标准 | `vitdec` mode='trunc' 完全一致 |
| 译码器无错帧 (Eb/N0=4.5dB) | BER ≤ 1e-5 |
| 软判决增益 (vs 硬判决) | ≥ 1.5dB @ BER=1e-5 |
| 定点模型 vs 浮点退化 | ≤ 0.1dB |
| 测试向量 KAT | 全零/全一/随机 100% 通过 |
| 回溯深度推荐值 | TB ≥ 5K (K=7 → 35, 推荐 50) |
