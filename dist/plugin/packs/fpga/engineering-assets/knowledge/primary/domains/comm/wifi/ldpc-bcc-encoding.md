---
name: ldpc-bcc-encoding
title: "WiFi 编码 — BCC 与 LDPC"
tags: [comm, wifi, ldpc, encoding]
description: "802.11a/g BCC → 802.11n LDPC — 编码选择、加扰、编码链差异"
related: [wifi/phy-layer.md, ../ldpc/algorithm_spec, ../ldpc/encoding_spec]
---

# WiFi 编码 — BCC 与 LDPC

> 最后更新: 2026-06-06
> 关联: [[phy-layer]], [[../ldpc/algorithm_spec|LDPC 算法规格书]], [[../ldpc/encoding_spec|LDPC 编码器规格书]]

---

## 1. 编码系统架构

```
MAC 帧数据 → 加扰 (Scrambler) → 编码选择 → 编码器 → 编码后处理
                                              ├── BCC: 流解析(puncturing) + 交织
                                              └── LDPC: 缩短 + 打孔 (if needed)
```

---

## 2. 加扰 (Scrambler)

所有 WiFi 数据帧在编码前必须加扰，用于数据白化 (避免长连 0/1 序列)。

```
加扰器: 自同步 LFSR, 多项式 G(z) = z^7 + z^4 + 1

┌─────────────────────────────────────┐
│ 初始种子: 非零伪随机 (127 种可能)     │  ┌─────────┐
│ LFSR: [x1 x2 x3 x4 x5 x6 x7]       │  │         │
│ 每时钟 shift: x1 ← x4 ⊕ x7         │──│ ⊕ 数据位│→ 加扰输出
│              x{i+1} ← x{i}          │  │         │
└─────────────────────────────────────┘  └─────────┘

SERVICE 字段的位 0-6 作为加扰种子 (802.11a/g/n/ac)。
802.11ax: 每个符号使用新种子重新加扰。
```

---

## 3. BCC 编码链 (802.11a/g/n/ac/ax)

```
加扰数据 → BCC 编码 → 流解析 → 打孔 → 交织 → 星座映射

BCC 尾比特 (Tail Bits):
  ┌──────────────────────────────────────────┐
  │ 每段数据末端追加 6 个零 bit (Tail)       │
  │ 目的: 将卷积编码器重置到全 0 状态        │
  │ 开销: 每段 6 bit → 相当于多 1 OFDM 符号  │
  └──────────────────────────────────────────┘
```

**编码器细节**:

| 参数 | 值 |
|:----|:---|
| 约束长度 K | 7 |
| 母码码率 | 1/2 |
| 生成多项式 | $g_0 = 133_8$ (输出 A) |
| | $g_1 = 171_8$ (输出 B) |
| 打孔 | 按码率模板 (2/3, 3/4, 5/6) |

**BCC 流解析 (802.11n/ac/ax MIMO)**:

将编码后比特循环分配到多个流 (每流独立交织):

```
编码比特: b0 b1 b2 b3 b4 b5 ...

N_ss=2:
  Stream 0: b0 b2 b4 ...
  Stream 1: b1 b3 b5 ...
```

---

## 4. LDPC 编码链 (802.11n/ac/ax/be)

```
加扰数据 → LDPC 编码 → 缩短 (短包) → 打孔 (码率调整) → 流解析 → 星座映射
```

**编码流程 (802.11n QC-LDPC)**:

```
① 选择码字长度: 648 / 1296 / 1944 bits (基于 PSDU 长度选择)
② 选择码率: 1/2, 2/3, 3/4, 5/6
③ 数据填充: 如果数据 < K 信息位 → 前置零填充
④ 编码: H × c^T = 0 (采用双对角加速)
⑤ 缩短: 移除填充的零位 (不影响校验位)
⑥ 打孔 (可选): 如果编码后比特超过可用子载波数 → 打孔校验位
```

**各代 LDPC 支持**:

| 代 | LDPC 地位 | 码长 | 特性 |
|:--:|:---------:|:----:|:-----|
| 802.11n | 可选 | 648/1296/1944 | 基础 QC-LDPC |
| 802.11ac | 可选 | 同 n | 增加 256QAM 支持 |
| 802.11ax | 可选 | 同 n | 增加 1024QAM 支持, IR 方案改进 |
| 802.11be | **强制** | 同 n | LDPC 编码器必须实现 |

> **802.11be EHT 反转**: LDPC 从可选升级为强制，BCC 降为可选。
> 原因: 4096QAM 下 BCC 性能不足以支撑 35dB SNR 要求的 FER。

详情见: [[../ldpc/algorithm_spec|LDPC 算法规格书]], [[../ldpc/encoding_spec|LDPC 编码器规格书]]

---

## 5. BCC vs LDPC 选择指南

| 条件 | 推荐编码 | 原因 |
|:----|:--------:|:-----|
| 短包 (< 100 字节) | BCC | LDPC 编码增益因缩短而损失 |
| 高码率 (5/6) | LDPC | LDPC 5/6 优于或等于 BCC 5/6 |
| 低 SNR (~5 dB) | BCC | BPSK/BCC 1/2 已有足够分集 |
| 高 SNR (> 25 dB) | LDPC | LDPC 在高阶调制下编码增益更大 |
| 硬件资源受限 | BCC | BCC 消耗逻辑远少于 LDPC |
| 802.11be 强制 | **LDPC** | 接收端最低必须支持 LDPC 解码 |

---

## 6. FPGA 实现要点

### 6.1 加扰器 (最小面积)

```verilog
// 自同步加扰器: G(z) = z^7 + z^4 + 1
// 初始种子: SERVICE[0:6] (非零)
reg [6:0] scrambler;
wire feedback = scrambler[6] ^ scrambler[3]; // x7 ⊕ x4
always @(posedge clk) begin
  if (init) scrambler <= seed;
  else begin
    scrambler <= {scrambler[5:0], feedback};
    data_out <= data_in ^ feedback;
  end
end
```

### 6.2 BCC 编码器

```verilog
// 约束长度 K=7, g0=133_o, g1=171_o
reg [6:0] conv_enc; // 移位寄存器
wire out_a = ^(conv_enc & 8'b1011011); // g0 = 133_o = 'b1_011_011
wire out_b = ^(conv_enc & 8'b1111001); // g1 = 171_o = 'b1_111_001
```

### 6.3 资源对比

| 模块 | LUT | FF | BRAM | 吞吐 |
|:----|:---:|:--:|:----:|:----:|
| 加扰器 | ~10 | 7 | 0 | 1 bit/clk |
| BCC 编码器 | ~30 | 7 | 0 | 1 bit/clk |
| BCC 打孔器 | ~20 | 0 | 0 | 1 bit/clk |
| LDPC 编码器 | ~500 | ~500 | 0~2 | >1 bit/clk (Z 路并行) |

> LDPC 编码器面积约比 BCC 大 10~15×，但吞吐可通过 Z 路并行线性扩展。
