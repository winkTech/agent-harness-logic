# OFDM 发射机 RTL 架构设计

## 1. 整体架构

```
                     ram_wr_addr
          s_axis ──→ [输入FIFO] ──→ [Mod Mapper] ──→ [Pilot Insert]
                                                         │
                    ┌────────────────────────────────────┘
                    │
                    ▼
     rom_cos/sin ──→ [IFFT Core] ←── cfg(N, scale)
                    │
                    ▼
               [CP Insert] ──→ [成形滤波] ──→ m_axis
```

### 数据流

- 输入数据按 AXI4-Stream 写入输入 FIFO
- Mod Mapper 从 FIFO 读取，按调制方式映射为 I/Q 符号
- Pilot Insert 在指定位置插入导频和 DC 空子载波
- IFFT Core 将频域符号变换为时域采样点
- CP Insert 将 IFFT 输出的尾部 N_CP 个样点复制到头部
- 成形滤波(可选)对时域信号进行脉冲成形

---

## 2. 模块详细设计

### 2.1 Mod Mapper

**功能:** 将比特流映射为调制符号

**调制方式与映射表:**

| 调制 | bits/符号 | I/Q 幅度 | 实现方式 |
|------|-----------|----------|----------|
| BPSK | 1 | ±1 | LUT(2 entries) |
| QPSK | 2 | ±1/√2 | LUT(4 entries) |
| 16QAM | 4 | ±1/√10, ±3/√10 | LUT(16 entries) |
| 64QAM | 6 | ±1/√42, ±3/√42, ±5/√42, ±7/√42 | LUT(64 entries) |

**接口:**

```verilog
module mod_mapper #(
    parameter MOD_TYPE = 2  // 0:BPSK, 1:QPSK, 2:16QAM, 3:64QAM
) (
    input  wire         clk, rst_n,
    // Input (bits)
    input  wire [5:0]   s_axis_tdata,  // up to 6 bits for 64QAM
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    // Output (IQ symbols)
    output wire [15:0]  m_axis_tdata,  // {I[7:0], Q[7:0]}
    output wire         m_axis_tvalid,
    input  wire         m_axis_tready
);
```

**延迟:** 1 clock

---

### 2.2 Pilot Insert

**功能:** 在指定子载波位置插入导频符号和 DC 空子载波

**子载波分配(WiFi 64点FFT):**

```
子载波索引: -32  -31 ... -27  -26 ... -1  0  +1 ... +26  +27 ... +31
            │    │         │         │  │  │        │         │
           DC  Guard     Pilot    Data  DC Data    Pilot    Guard
```

**导频模式:**

| OFDM 符号索引 | 导频值(归一化) |
|---------------|---------------|
| 偶数符号 | {+1, +1, +1, -1} |
| 奇数符号 | {-1, -1, -1, +1} |

**实现:**

- 使用计数器追踪当前写入的子载波索引
- 在导频位置插入已知导频符号
- 在 Guard/DC 位置插入 0
- 在数据位置输出调制符号

**延迟:** 1 clock

---

### 2.3 IFFT Core

**功能:** 将频域符号变换为时域采样点

**架构选择:**

| 方案 | 资源(DSP48@64点) | 延迟 | 特点 |
|------|------------------|------|------|
| Xilinx FFT IP | 12 | 65 clk | 推荐，已优化 |
| 自研基-4 | 24 | 48 clk | 吞吐更高但资源翻倍 |
| 流式基-2 | 8 | ~200 clk | 资源最少，延迟大 |

**推荐: Xilinx FFT IP Core**

| 配置项 | 设置 |
|--------|------|
| Transform Length | 64 (参数化) |
| Architecture | Pipelined Streaming |
| Data Format | Fixed Point |
| Scaling | Block Floating Point |
| Rounding Mode | Truncation |
| I/O Width | 16 bit |

**时序:**

```
FFT 输入到输出延迟 = N + pipeline_delay ≈ 65 clk (N=64)
吞吐 = 1 sample/clock (连续模式)
```

---

### 2.4 CP Insert

**功能:** 将 IFFT 输出尾部 N_CP 个样点复制到头部

**实现方式:**

```
方式1: RAM Buf fer
[写入 RAM]         → 写满 N 点
[读取 CP 部分]     → 读尾部 N_CP 个点
[读取全部 N 点]    → 输出 N + N_CP 个点

方式2: Dual RAM Ping-Pong
RAM_A 写入 IFFT 输出
RAM_B 读取 CP + 全部输出
下一符号交替
```

**推荐: Dual RAM Ping-Pong** (吞吐连续无气泡)

**延迟:** N_CP + N 时钟周期（输出第一个样点）

---

## 3. 流水线分析

| 阶段 | 模块 | 延迟(clk) | 说明 |
|------|------|-----------|------|
| S1 | Input FIFO | 1 | 数据准备 |
| S2 | Mod Mapper | 1 | 调制映射 |
| S3 | Pilot Insert | 1 | 导频+Guard |
| S4 | IFFT | ~65 | 核心变换 |
| S5 | CP Insert | N_CP | 循环前缀 |
| S6 | Filter(可选) | tap_delay | 成形滤波 |
| **总延迟** | | ~85+N_CP | |

---

## 4. 时序约束

```tcl
# 主时钟
create_clock -name clk -period 10.000 [get_ports clk]

# 输入延迟
set_input_delay -clock clk -max 3.000 [get_ports s_axis_t*]
set_input_delay -clock clk -min 1.000 [get_ports s_axis_t*]

# 输出延迟
set_output_delay -clock clk -max 4.000 [get_ports m_axis_t*]
set_output_delay -clock clk -min 1.000 [get_ports m_axis_t*]

# 虚假路径 (配置接口)
set_false_path -from [get_ports a*_axi_*]
```

---

## 5. 可配置性

| parameter | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| FFT_LEN | int | 64 | FFT 点数 |
| CP_LEN | int | 16 | CP 长度 |
| MOD_TYPE | int | 2 | 0:BPSK 1:QPSK 2:16QAM 3:64QAM |
| DATA_WIDTH | int | 16 | 数据位宽 |
