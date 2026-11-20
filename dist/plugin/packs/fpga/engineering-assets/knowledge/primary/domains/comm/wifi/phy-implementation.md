---
name: phy-implementation
title: "WiFi PHY 实现架构 — 接收机/发射机 FPGA 实现"
tags: [comm, wifi, phy, fpga, implementation]
description: "包检测 → CFO校正 → FFT → 信道估计 → LLR解调 → 解码 全硬件流水线"
related: [wifi/phy-layer.md, wifi/overview.md, ../synch/algorithm_spec]
---

# WiFi PHY 实现架构 — FPGA 实现

> 最后更新: 2026-06-06
> 关联: [[phy-layer]], [[../synch/algorithm_spec|同步算法]]

---

## 1. 发射机架构 (TX)

### 1.1 整体数据通路

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ 编码     │→  │ 加扰     │→  │ 星座映射  │→  │ 导频插入  │→  │ 子载波映射│
│ (BCC/    │   │ (自同步   │   │ (BPSK~    │   │ (4 导频   │   │ (直流/边  │
│  LDPC)   │   │  LFSR)   │   │  4096QAM) │   │  子载波)  │   │  带保护)  │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────┬───┘
                                                                     │
┌──────────┐   ┌──────────┐   ┌──────────┐                          │
│ GI 插入  │←  │ 加窗     │←  │ IFFT     │←──────────────────────────┘
│ (CP:16/  │   │ (窗函数   │   │ (64/128/ │
│  32/64   │   │  降旁瓣)  │   │  256/512)│
│  样点)   │   │          │   │          │
└────┬─────┘   └──────────┘   └──────────┘
     │
     ↓
┌──────────────┐   ┌──────────┐
│ L-STF/L-LTF/ │→  │ DAC + RF │→ 天线
│ SIG 插入     │   │ (IQ调制) │
│ (preamble    │   │          │
│  生成器)     │   │          │
└──────────────┘   └──────────┘
```

### 1.2 Preamble 生成器

**L-STF 生成 (时域)**:

```verilog
// 802.11a L-STF: 10 × 0.8μs = 8μs 重复短序列
// 16-sample 短序列 (64-FFT 的周期延拓)
// 频域: 每 4 子载波插一个 BPSK ±1

wire [15:0] stf_seq[15:0];
assign stf_seq = '{
    16'h0C6B, 16'h113C, 16'h1F68, 16'h1F68,  // I 路
    16'h1F68, 16'h113C, 16'h0C6B, 16'h0DE9,
    16'h1E71, 16'h103B, 16'h0F98, 16'h1268,
    16'h105F, 16'h0B58, 16'h1FE1, 16'h1D6B
};

// 10 次重复发送
reg [3:0] stf_repeat_cnt;
always @(posedge clk) begin
    if (stf_active) begin
        addr <= addr + 1;
        if (addr == 15) begin
            addr <= 0;
            stf_repeat_cnt <= stf_repeat_cnt + 1;
        end
    end
end
```

**L-LTF 生成**:

```
L-LTF: 2 个 64-sample 长序列 + 32-sample CP (GI2)
总长: 32 + 64 + 64 = 160 samples = 8μs

频域: 52 个有效子载波 (index -26~-1, +1~+26)
序列 S[-26:26] = { 1,1,-1,-1,1,1,-1,1,-1,1,1,1,1,1,1,-1,-1,1,1,-1,1,-1,1,1,1,1,
                  0,  // DC
                  1,-1,-1,1,1,-1,1,-1,1,-1,-1,-1,-1,-1,1,1,-1,-1,1,-1,1,-1,1,1,1,1 }
```

**时域构造**: 对 64 点频域序列做 IFFT → 取最后 32 点作为保护间隔 → 级联 2 个 64 点符号。

### 1.3 加窗 (Window)

时域加窗降低 OFDM 符号间频谱泄漏：

```
符号 n-1              符号 n
         │<── GI 重叠窗──>│
         └───────────────┘
      ┌──────────────────────┐
      │  升余弦窗 (升/降沿)   │
      │  rolloff = 0.25 (4s)│
      └──────────────────────┘

// 升余弦窗系数 (16 点, 上升沿)
wire [15:0] win_coeff_rise[15:0];
assign win_coeff_rise = '{
    16'h0000, 16'h0C7B, 16'h18F8, 16'h257A,
    16'h3204, 16'h3E99, 16'h4B3E, 16'h57F7,
    16'h64CA, 16'h71BA, 16'h7ECE, 16'h8C09,
    16'h9972, 16'hA70E, 16'hB4E0, 16'hC2ED
};
// 下降沿: 对称, reverse(win_coeff_rise) 再按位取补
```

| 参数 | 值 |
|:----|:---|
| 窗类型 | 升余弦 (raised cosine) |
| Rolloff | 0.25 (802.11n/ac 默认) |
| 窗口长度 N_w | 4 个 over-sampled sample (64-FFT) |
| 效果 | 降低 ACLR ~3 dB |

---

## 2. 接收机架构 (RX)

### 2.1 整体流水线

```
RF(ADC)
  │
  │  I/Q 采样 (20/40/80/160 MHz)
  ↓
┌──────────────────┐
│ 自动增益控制 AGC  │ ← L-STF 期间完成增益设定 (64×16=1024 samples)
│  功率检测        │   目标: 满量程 50~80% 范围
└───────┬──────────┘
        ↓
┌──────────────────┐
│ 直流/频偏校正     │ ← DC offset 补偿 (L-STF 均值法)
│ DC offset 消除    │
│ CFO 粗估计 + 补偿 │ ← L-STF 自相关 (延时 16 sample)
└───────┬──────────┘
        ↓
┌──────────────────┐
│ 包检测            │ ← 自相关门限法
│ (packet detect)  │
└───────┬──────────┘
        ↓
┌──────────────────┐
│ CFO 精估计 + 补偿 │ ← L-LTF 互相关 (延时 64 sample)
└───────┬──────────┘
        ↓
┌──────────────────┐
│ FFT + 去 CP      │ ← 可配置 FFT IP (64/128/256/512)
│                                                   │
│     ┌────────────┴────────────┐                    │
│     ↓                         ↓                    │
│ ┌──────────┐          ┌──────────────┐              │
│ │信道估计   │          │ L-SIG 解码    │              │
│ │ (L-LTF LS)│          │ (BPSK 1/2 →   │              │
│ │           │          │  rate/length) │              │
│ └─────┬─────┘          └──────┬───────┘              │
│       ↓                      ↓                       │
│     ┌──────────────────────────────────┐              │
│     │ SIG-A/B 解码 (HT/VHT/HE/EHT)    │              │
│     │ → BW、MCS、NSTS、编码类型、GI    │              │
│     └──────────────┬───────────────────┘              │
└────────────────────┼──────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 信道均衡 (MMSE)                                       │
│ 每子载波: Y_eq[k] = Y[k] × H*[k] / (|H[k]|² + σ²)  │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌──────────────────────┐
│ 相位跟踪 (导频)       │ ← 每 OFDM 符号用 4 导频更新公共相位
│ 公共相位误差 (CPE)    │
└──────────────────────┘
                       ↓
┌──────────────────────┐
│ 解调 (LLR 计算)       │ ← BPSK~4096QAM 软比特生成
└──────┬───────────────┘
       ↓
┌──────────────────────┐
│ 解交织 → 解码         │ ← BCC Viterbi / LDPC MinSum
└──────────────────────┘
```

### 2.2 流水线时序

```
                           L-STF(8μs)         L-LTF(8μs)     SIG(4μs)    Data
RX ADC ─┬────────────────┬────────────────┬────────────────┬──────────────
         │                │                │                │
AGC      ████████████░░░░░│                │                │
         │  ~2μs 建立增益  │                │                │
包检测    ░░░███░░░░░░░░░░░│                │                │
         │  延时相关(2μs)  │                │                │
CFO粗     ░░░░░░░██████████│                │                │
         │  16-sample 相关 │                │                │
CFO精     ░░░░░░░░░░░░░░░░│████████        │                │
         │                │  64-sample 相关  │                │
信道估计   ░░░░░░░░░░░░░░░░│██████████░░░░░░│                │
         │                │  累加→平均 → 插值 │                │
FFT       ░░░░░░░░░░░░░░░░│░░░░░░░██████████│██████████      │
         │                │                │                │
SIG解码    ░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░│██████████░░░░░ │
         │                │                │  解码获得 MCS/NSTS
均衡      ░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░│░░░░░░░░░░████████
         │                │                │                │
解调      ░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░████

→ 延迟: 从触发到第一个 data LLR 约 28~32 μs (20MHz BW)
→ 流水线每级 2~4 μs 预算 (20MHz: 64-samples × 50ns = 3.2μs)
```

---

## 3. 包检测 (Packet Detection)

### 3.1 自相关法

```
L-STF 的周期自相关 (延时 D = 16 samples = 0.8μs):

          N-1
C[n] =    Σ   r[n+m] × conj(r[n+m+D])
          m=0
          N-1
P[n] =    Σ   |r[n+m+D]|²
          m=0

检测门限: M[n] = |C[n]|² / P[n]² > Thresh

         ┌─── 相关窗口 ───┐
样本: ...│0 1 2 ... 15│0 1 2 ... 15│...
         └───── D=16 ────┘
```

### 3.2 实现结构

```verilog
// 自相关器 (延时 D=16, 窗口 N=64)
module autocorr #(
    parameter W = 16,   // 数据位宽
    parameter N = 64,   // 窗口长度
    parameter D = 16    // 延时
)(
    input  clk,
    input  signed [W-1:0] r_i,
    input  signed [W-1:0] r_q,
    output logic [2*W-1:0] mag,   // |C[n]|²
    output logic [2*W-1:0] power, // P[n]²
    output logic detect           // 包检测指示
);

    // 延时线 (D 拍)
    logic signed [W-1:0] dly_i [D], dly_q [D];
    always_ff @(posedge clk) begin
        dly_i[0] <= r_i; dly_q[0] <= r_q;
        for (int i=1; i<D; i++) begin
            dly_i[i] <= dly_i[i-1];
            dly_q[i] <= dly_q[i-1];
        end
    end

    // 复数乘法 C = r[n] × conj(r[n-D])
    logic signed [2*W-1:0] cmul_i, cmul_q;
    assign cmul_i = r_i * dly_i[D-1] + r_q * dly_q[D-1];
    assign cmul_q = r_q * dly_i[D-1] - r_i * dly_q[D-1];

    // 滑动平均 (移位累加)
    logic signed [2*W+6-1:0] acc_i, acc_q, acc_p;
    logic signed [2*W+6-1:0] ring_i [N], ring_q [N], ring_p [N];

    always_ff @(posedge clk) begin
        acc_i <= acc_i + cmul_i - ring_i[0];
        acc_q <= acc_q + cmul_q - ring_q[0];
        acc_p <= acc_p + power_in - ring_p[0];
        // 环形缓冲更新...
    end

    // 平方幅度计算
    assign mag   = acc_i * acc_i + acc_q * acc_q;
    assign power = acc_p * acc_p;

    // 门限比较 (可编程)
    localparam THRESH = 32'h0000_4000;  // 0.25 Q1.30
    assign detect = (mag > (power >> 2)) & (power > MIN_POWER);
endmodule
```

### 3.3 参数

| 参数 | 典型值 | 说明 |
|:----|:------:|:-----|
| 延时 D | 16 samples | L-STF 周期 = 16 @ 20MHz |
| 窗口 N | 32~64 | 检测灵敏度和虚警的权衡 |
| 门限 Thresh | 0.5~0.75 | 低于 0.5 易虚警, 高于 0.75 易漏检 |
| 最小功率 | 可编程 | 跳过静默期 |

---

## 4. 频偏估计 (CFO Estimation)

### 4.1 粗估计 (L-STF)

```
粗 CFO 基于 L-STF 自相关的 **相位**:

φ_coarse = angle(C[n])   // n 在 L-STF 中段
Δf_coarse = φ_coarse / (2π × D × Ts)

D × Ts = 16 × 50ns = 0.8μs
最大可估频偏: |Δf_max| = 1/(2 × D × Ts) = 625 kHz (20MHz BW)

实现: CORDIC atan2(I,Q) 或查表近似
```

```verilog
// 粗 CFO 估计 (CORDIC 流水线)
module cfo_est_coarse #(
    parameter W = 16,
    parameter STAGES = 16
)(
    input clk,
    input signed [2*W-1:0] acc_i,   // 累加 C[n] 实部
    input signed [2*W-1:0] acc_q,   // 累加 C[n] 虚部
    output signed [W-1:0] cfo_angle // 归一化角度 [-π, π)
);

    // CORDIC atan2 流水线 (16 级)
    logic signed [2*W-1:0] x [STAGES], y [STAGES];
    logic [STAGES-1:0] z [STAGES];
    // ... CORDIC 迭代 ...

    // 输出到 NCO 做频率补偿
    // Δf_coarse = z[STAGES-1] / (2π × D × Ts)
endmodule
```

### 4.2 精估计 (L-LTF)

```
利用 L-LTF 两个 64-sample 长序列的互相关:

φ_fine = angle( Σ r[n+64] × conj(r[n]) )   // n 在 L-LTF 第一半

Δf_fine = φ_fine / (2π × 64 × Ts)
最大可估频偏: |Δf_max| = 156.25 kHz (20MHz)

组合: Δf_total = Δf_coarse + Δf_fine
补偿: r_comp[n] = r[n] × exp(-j×2π×Δf_total×n×Ts)
```

### 4.3 NCO + 混频器实现

```verilog
// 数字混频器 (频偏补偿)
module mixer #(
    parameter W = 16,
    parameter PHASE_W = 20
)(
    input clk, rst,
    input signed [W-1:0] d_i, d_q,
    input signed [PHASE_W-1:0] phase_inc,  // Δf × 2^PHASE_W
    output signed [W-1:0] out_i, out_q
);

    logic [PHASE_W-1:0] phase_acc;
    logic signed [W-1:0] sin, cos;

    // 相位累加器 (NCO)
    always_ff @(posedge clk) begin
        if (rst) phase_acc <= 0;
        else     phase_acc <= phase_acc + phase_inc;
    end

    // LUT 查表 (存储 sin/cos 波形)
    // 或 CORDIC 实时计算
    sin_cos_lut #(.W(W), .PHASE_W(PHASE_W)) lut_inst (
        .phase(phase_acc),
        .sin(sin), .cos(cos)
    );

    // 复数乘法: r × e^{-jθ}
    assign out_i = d_i * cos + d_q * sin;  // >> (W-1)
    assign out_q = d_q * cos - d_i * sin;  // >> (W-1)
endmodule
```

---

## 5. FFT 引擎

### 5.1 参数配置

| 带宽 | 采样率 | FFT 尺寸 | 子载波间距 | 数据子载波 | 符号时长 |
|:----:|:-----:|:--------:|:----------:|:---------:|:--------:|
| 20 MHz | 20 Msps | 64 | 312.5 kHz | 52 (48+4导频) | 3.2 μs |
| 40 MHz | 40 Msps | 128 | 312.5 kHz | 108 | 3.2 μs |
| 80 MHz | 80 Msps | 256 | 312.5 kHz | 234 | 3.2 μs |
| 160 MHz | 160 Msps | 512 | 312.5 kHz | 468 | 3.2 μs |
| 320 MHz | 320 Msps | 1024 | 312.5 kHz | 980 | 3.2 μs |

> **注意**: 802.11ax/be 子载波间距改为 78.125 kHz (原 312.5 kHz × 1/4)，FFT 尺寸 ×4。

### 5.2 FFT 集成

```verilog
// Xilinx FFT IP 配置示例 (20MHz BW, 64-FFT)
module fft_wrapper #(
    parameter N_FFT = 64,
    parameter DATA_W = 16,
    parameter TWIDDLE_W = 16
)(
    input clk, rst,
    input [DATA_W*2-1:0] din,    // {I, Q}
    input din_valid,
    output logic din_ready,
    output [DATA_W*2-1:0] dout,  // {I, Q} 频域输出
    output dout_valid
);

    // 配置: Pipelined Streaming I/O, 自然序输出
    // 缩放: Block Floating Point (BFP) 或逐级 1/2 缩放
    xfft_0 fft_inst (
        .aclk(clk),
        .aresetn(~rst),
        .s_axis_data_tdata({din[DATA_W-1:0], din[2*DATA_W-1:DATA_W]}),
        .s_axis_data_tvalid(din_valid),
        .s_axis_data_tready(din_ready),
        .m_axis_data_tdata(fft_out),
        .m_axis_data_tvalid(dout_valid),
        .event_frame_started(),
        .event_tlast_missing()
    );
endmodule
```

### 5.3 去 CP + FFT 调度

```
时序图 (64-FFT, GI=16):

个OFDM符号
 │<── CP (16 samples) ──>│<── FFT (64 samples) ──>
 │                        │
 │ 写 BRAM @ addr 0~15   │  读 BRAM addr 16~79 →
 │                        │  FFT 输入
 │ 下一符号 CP 写入同时   │  上一符号 FFT 处理
 │ 上一符号 FFT 输出同时   │  乒乓缓冲

双缓冲 (ping-pong):
  clk:  |0  16|17 80|81 96|97 160|161 176|
  buf0: |写CP |  FFT| 读  | 写CP |  FFT| ...
  buf1: | FFT | 读  | 写CP | FFT  | 读  | ...
```

---

## 6. 信道估计 (Channel Estimation)

### 6.1 LS 估计 — L-LTF

```
L-LTF 含 2 个相同的 64-sample 长序列 (L1, L2):

H_LS[k] = (Y1[k] + Y2[k]) / (2 × X_LTF[k])

其中:
  Y1[k], Y2[k] = L1, L2 的 FFT 输出
  X_LTF[k]     = L-LTF 频域参考序列 (BPSK, ±1)
  k            = -26~-1, +1~+26 (跳过 DC)

实现: 乘法 + 移位 (因为 X_LTF[k] ∈ {±1})
H[k] = (Y1[k] + Y2[k]) × X_LTF[k] / 2
```

```verilog
// LS 信道估计 (L-LTF)
module ch_est_lltf #(
    parameter DATA_W = 16,
    parameter N_SC = 52  // 有效子载波数
)(
    input clk, rst,
    input signed [DATA_W-1:0] fft_i1 [N_SC],  // L1 FFT 输出 I
    input signed [DATA_W-1:0] fft_q1 [N_SC],  // L1 FFT 输出 Q
    input signed [DATA_W-1:0] fft_i2 [N_SC],  // L2
    input signed [DATA_W-1:0] fft_q2 [N_SC],
    output signed [DATA_W+1-1:0] h_est_i [N_SC],  // 信道估计 I
    output signed [DATA_W+1-1:0] h_est_q [N_SC]   // 信道估计 Q
);

    // L-LTF 参考序列 (频域 BPSK)
    // S[0:51] = {±1, ±1, ...}
    logic signed [1:0] ltf_ref [N_SC];
    // ... 初始化参考序列 ...

    always_ff @(posedge clk) begin
        for (int k=0; k<N_SC; k++) begin
            // H = (Y1 + Y2) × conj(X_ltf) / 2
            // X_ltf ∈ {±1}, 所以乘法简化为取符号
            if (ltf_ref[k] == 1) begin
                h_est_i[k] <= (fft_i1[k] + fft_i2[k]) >>> 1;
                h_est_q[k] <= (fft_q1[k] + fft_q2[k]) >>> 1;
            end else begin
                h_est_i[k] <= -(fft_i1[k] + fft_i2[k]) >>> 1;
                h_est_q[k] <= -(fft_q1[k] + fft_q2[k]) >>> 1;
            end
        end
    end

endmodule
```

### 6.2 MMSE 均衡器

```
均衡器输出:
  X_eq[k] = H*[k] × Y[k] / (|H[k]|² + σ²)
  
其中 σ² 为噪声方差估计 (可以从 L-LTF 残留误差计算):
  σ² = E[|Y1 - Y2|² / 2]

实现定点:
  1. 计算 |H|² = H_i² + H_q²
  2. 加噪声正则项 σ² (防止除零)
  3. 除法用 CORDIC 或查表 (1/(|H|² + σ²))
  4. 乘回 Y
```

```verilog
// MMSE 均衡 — 单子载波
module mmse_eq #(
    parameter DW = 16,
    parameter SQNR_DW = 12
)(
    input clk,
    input signed [DW-1:0] y_i, y_q,        // FFT 输出
    input signed [DW-1:0] h_i, h_q,        // 信道估计
    output logic signed [DW-1:0] x_i, x_q, // 均衡输出
    output logic signed [SQNR_DW-1:0] snr  // 每子载波 SNR (用于 LLR)
);

    wire signed [2*DW-1:0] h_sq = h_i * h_i + h_q * h_q;
    wire signed [2*DW+SIGMA_W-1:0] denom = h_sq + sigma_sq;

    // 复数除法: X = H* × Y / denom
    wire signed [2*DW-1:0] num_i = h_i * y_i + h_q * y_q;  // Re(H* × Y)
    wire signed [2*DW-1:0] num_q = h_i * y_q - h_q * y_i;  // Im(H* × Y)

    // 除法器 (流水线, 8~16 级)
    div_pipelined #(.A_W(2*DW), .B_W(2*DW+SIGMA_W))
        div_i (.num(num_i), .den(denom), .quot(x_i));
    div_pipelined #(.A_W(2*DW), .B_W(2*DW+SIGMA_W))
        div_q (.num(num_q), .den(denom), .quot(x_q));

    assign snr = h_sq >>> (2*DW - SQNR_DW - 1);  // SNR 估计
endmodule
```

### 6.3 噪声方差估计

```
σ² = (1/2N) × Σ|Y1[k] - Y2[k]|²    // 跨 L-LTF 两个符号

硬件: 累加 L1-L2 的平方差 → 右移 log2(N)+1
```

---

## 7. 相位跟踪 (Phase Tracking)

### 7.1 公共相位误差 (CPE)

```
每 OFDM 数据符号, 用 4 个导频子载波估计公共相位:

φ_est = angle( Σ Pilot[k] × conj(Pilot_ref[k]) × H_coarse_comp )

补偿: Y_comp = Y × exp(-j×φ_est)

导频位置:
  - 802.11a/n: 子载波 -21, -7, +7, +21
  - 802.11ac: 同上 (80MHz 内每 20MHz 段 4 个)
```

### 7.2 实现

```verilog
module phase_tracker #(
    parameter DW = 16,
    parameter N_PILOTS = 4
)(
    input clk,
    input signed [DW-1:0] p_i [N_PILOTS],  // 导频 FFT 输出 I
    input signed [DW-1:0] p_q [N_PILOTS],  // 导频 FFT 输出 Q
    input signed [DW-1:0] p_ref_i [N_PILOTS], // 导频参考
    input signed [DW-1:0] p_ref_q [N_PILOTS],
    input signed [DW-1:0] data_i, data_q,  // 数据子载波
    output signed [DW-1:0] comp_i, comp_q  // 相位补偿后
);

    // 累加: Σ P × conj(P_ref)
    logic signed [2*DW+3-1:0] sum_i, sum_q;
    always_ff @(posedge clk) begin
        sum_i <= 0; sum_q <= 0;
        for (int n=0; n<N_PILOTS; n++) begin
            sum_i <= sum_i + p_i[n] * p_ref_i[n] + p_q[n] * p_ref_q[n];
            sum_q <= sum_q + p_q[n] * p_ref_i[n] - p_i[n] * p_ref_q[n];
        end
    end

    // 角度 → 小角度近似 (SINR高时 φ ≈ sin(φ) ≈ Q/|sum|)
    // 实际: CORDIC 或 2次小角度展开
    // 补偿: 复数乘法 × exp(-jφ)
    // ...
endmodule
```

---

## 8. 解调 — LLR 计算

### 8.1 通用 LLR 公式

```
对于 AWGN 信道, 每符号软比特 LLR:

LLR(b_k) = ln( P(b_k=1|y) / P(b_k=0|y) )
         = (1/σ²) × ( min_{s ∈ S₀} |y - h·s|² - min_{s ∈ S₁} |y - h·s|² )

简化 (Max-Log-MAP):
LLR ≈ (|h|²/σ²) × ( min_{s ∈ S₀} |y' - s|² - min_{s ∈ S₁} |y' - s|² )
其中 y' = y/h (已经均衡)
```

### 8.2 BPSK/QPSK LLR

```verilog
// BPSK LLR (简化): LLR = 2 × |h|² × y' / σ²
assign llr_bpsk = (h_sq * y_i) >>> (NORM_BITS);  // y_i > 0 → LLR > 0

// QPSK LLR: 独立 I/Q 分量
assign llr_qpsk_i = (h_sq * y_i) >>> (NORM_BITS);
assign llr_qpsk_q = (h_sq * y_q) >>> (NORM_BITS);
```

### 8.3 16QAM LLR

```
16QAM 比特映射 (格雷码):
  b0: I 符号
  b1: Q 符号  
  b2: |I| (幅值)
  b3: |Q| (幅值)

LLR(b0) = (|h|²/σ²) × y'[I]
LLR(b1) = (|h|²/σ²) × y'[Q]
LLR(b2) = (|h|²/σ²) × (2a - |y'[I]|)    // a = 归一化因子
LLR(b3) = (|h|²/σ²) × (2a - |y'[Q]|)
```

```verilog
// 16QAM LLR 计算
module llr_16qam #(
    parameter DW = 16,
    parameter LLR_W = 8
)(
    input signed [DW-1:0] y_i, y_q,       // 均衡输出
    input signed [2*DW-1:0] h_sq,         // |h|²
    input signed [DW-1:0] sigma_sq,       // 噪声方差
    output signed [LLR_W-1:0] llr [3:0]   // b0~b3
);

    // 归一化因子: 16QAM 星座点 = {±1, ±3}
    localparam A = 2;  // QPSK 归一化幅值
    localparam NORM = 8;  // 固定点缩放

    wire signed [2*DW+LLR_W-1:0] snr = (h_sq << LLR_W) / sigma_sq;
    wire signed [DW+LLR_W-1:0] y_i_scaled = y_i * snr[LLR_W-1:0];
    wire signed [DW+LLR_W-1:0] y_q_scaled = y_q * snr[LLR_W-1:0];

    assign llr[0] = y_i_scaled >>> NORM;         // b0: I
    assign llr[1] = y_q_scaled >>> NORM;         // b1: Q
    assign llr[2] = ( (A << LLR_W) - ($signed({1'b0, $unsigned(y_i_scaled)}) ) ) >>> NORM;  // b2: |I|
    assign llr[3] = ( (A << LLR_W) - ($signed({1'b0, $unsigned(y_q_scaled)}) ) ) >>> NORM;  // b3: |Q|
endmodule
```

### 8.4 64QAM/256QAM LLR (分段线性近似)

```
高阶 QAM 采用分段线性近似避免指数运算:

64QAM (每符号 6 bit, I/Q 各 3):
  b0: y'[I]  (符号)
  b2: 4a - |y'[I]|            (双绝对值)
  b4: | |y'[I]| - 2a | - a     (嵌套绝对值)

256QAM (每符号 8 bit): 推广至 4 段
4096QAM (每符号 12 bit): 推广至 6 段 (WiFi 7)
```

---

## 9. 解交织器 (Deinterleaver)

### 9.1 802.11a 交织

```
一次交织:  i = (N_cbps / 16) × (k mod 16) + floor(k/16),  k=0...N_cbps-1
二次交织:  j = s × floor(i/s) + (i + N_cbps - floor(16×i/N_cbps)) mod s
  其中 s = max(N_bpsc/2, 1)
```

### 9.2 乒乓 RAM 实现

```verilog
// 解交织器 (乒乓缓冲)
module deinterleaver #(
    parameter N_CBPS = 48,  // 20MHz, BPSK
    parameter DATA_W = 8
)(
    input clk, rst,
    input [DATA_W-1:0] llr_in,
    input in_valid,
    output [DATA_W-1:0] llr_out,
    output out_valid
);

    // 地址生成: 逆映射 (j→k 排列)
    // 完成一帧后立即反向读出
    // 乒乓: buf_a 写 (从 FFT 顺序) → buf_b 读 (解交织顺序)

    reg [DATA_W-1:0] mem_a [N_CBPS], mem_b [N_CBPS];
    reg ping_pong;
    reg [$clog2(N_CBPS)-1:0] wr_addr, rd_addr;

    // 解交织地址映射 (ROM)
    logic [$clog2(N_CBPS)-1:0] deint_addr [N_CBPS];
    // ... 初始化 deint_addr[rd] = 原始写入位置 ...

    always_ff @(posedge clk) begin
        if (in_valid) begin
            if (!ping_pong) mem_a[wr_addr] <= llr_in;
            else            mem_b[wr_addr] <= llr_in;
        end
        // 读: 按 deint_addr 映射
        if (!ping_pong) llr_out <= mem_b[deint_addr[rd_addr]];
        else            llr_out <= mem_a[deint_addr[rd_addr]];
    end
endmodule
```

---

## 10. 资源估算汇总

| 模块 | LUT | FF | BRAM (36K) | DSP48 | 说明 |
|:----|:---:|:--:|:----------:|:-----:|:-----|
| **AGC** | ~150 | ~100 | 0 | 0 | 功率检测 + 增益状态机 |
| **包检测** | ~800 | ~600 | 0 | 4 | 自相关 + 环形缓冲 (分布式 RAM) |
| **CFO 粗/精** | ~600 | ~400 | 0 | 2 | CORDIC atan2 + NCO |
| **NCO 混频器** | ~200 | ~150 | 1 | 2 | LUT 查表 + 复数乘法器 |
| **去 CP + FFT** | ~300 | ~200 | 2~4 | 0 | FFT IP 另算 |
| **FFT (64-pt)** | ~2K | ~2K | 4 | 12 | Xilinx FFT 7.1 pipelined |
| **FFT (256-pt)** | ~5K | ~5K | 12 | 24 | 80MHz BW |
| **FFT (1024-pt)** | ~12K | ~12K | 32 | 48 | 320MHz BW (EHT) |
| **信道估计** | ~600 | ~400 | 1 | 2 | 最大比合并 + 除法器 |
| **MMSE 均衡** | ~2K | ~1.5K | 0 | 8 | 每子载波除法复用 |
| **相位跟踪** | ~400 | ~300 | 0 | 4 | 导频累加 + 旋转 |
| **LLR 解调** | ~800 | ~400 | 0 | 4 | 分段线性 (复用) |
| **解交织** | ~200 | ~100 | 1~2 | 0 | 乒乓 RAM + 地址 ROM |
| **解码 (BCC)** | ~3K | ~2K | 0 | 0 | Viterbi 解码器 (K=7) |
| **解码 (LDPC)** | ~15K | ~10K | 4~8 | 0 | MinSum, 10 iter |
| **控制状态机** | ~500 | ~300 | 0 | 0 | PPDU 解析 + 流水线调度 |

**合计 (单流 20MHz BCC)**: ~12K LUT, ~8K FF, ~8 BRAM, ~26 DSP
**合计 (4×4 80MHz LDPC)**: ~60K LUT, ~40K FF, ~40 BRAM, ~80 DSP

---

## 11. 接收机状态机

```
状态机: IDLE → DETECT → CFO → CHEST → SIG → DATA → DONE

状态转移:
                                       ┌──────────────────────┐
                                       ↓                      │
  IDLE → DETECT → CFO → CHEST → SIG → DATA[0] → ... → DATA[N-1] → DONE → IDLE
    │        ↑       │       │       │                         │
    │        │       │       │       └── 解码 MCS/NSTS/BW ─────┘
    │        │       │       │       → DRV: 配置均衡/解调参数
    │        │       │       │
    │        │       │       └────── 选择 L-LTF 或 HE-LTF 方式
    │        │       │       → DRV: 配置 FFT 尺寸
    │        │       │
    │        │       └────────── CFO 补偿持续到数据结束
    │        │
    │        └────────────────── 超时 → 返回 IDLE (噪声误检)
    │
    └─────────────────────────── 接收完 → FCS 校验 → 转发 MAC

状态停留时长 (典型):
  DETECT: 4~6 μs    (L-STF)
  CFO:    4 μs      (L-STF 后半)
  CHEST:  8 μs      (L-LTF)
  SIG:    4~8 μs    (L-SIG + HE-SIG-A/B)
  DATA:   4 μs × N  (每 OFDM 符号)
```

---

## 12. 关于扩展

| 代 | 差异 | 影响模块 |
|:--:|:-----|:---------|
| 802.11n (HT) | MIMO 扩展 — Nss 流独立 FFT+均衡+LLR | N 倍 RX 模块 |
| | 40MHz → FFT 128 | FFT 参数 |
| 802.11ac (VHT) | 80/160MHz → FFT 256/512 | FFT |
| | MU-MIMO → 每用户需要独立信道估计+均衡 | 均衡 (用户分离) |
| 802.11ax (HE) | OFDMA → FFT 256/512/1024, 78.125kHz 子载波 | FFT, 子载波映射 |
| | 4× 导频密度 → 相位跟踪更鲁棒 | 相位跟踪 |
| | HE-LTF 模式 1x/2x/4x → 可配置导频密度 | 信道估计 |
| 802.11be (EHT) | 320MHz → FFT 1024 | FFT, 时钟速率 |
| | 4096QAM → LLR 分段线性扩展到 12 bit/符号 | LLR 计算 |
| | 16 流 MIMO → 均衡矩阵维度激增 | 均衡 (需 ZF/MMSE 矩阵解) |

---

## 参考

- IEEE Std 802.11-2020, §17-21 (OFDM PHY 规范)
- IEEE P802.11ax/D8.0 §27-28 (HE PHY)
- IEEE P802.11be/D5.0 §36-37 (EHT PHY)
- Xilinx PG109 — FFT LogiCORE IP Product Guide
- Xilinx PG269 — Viterbi Decoder v9.1
- Xilinx PG266 — LDPC Decoder v1.0
