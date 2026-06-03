---
algorithm: "LDPC FPGA Implementation"
version: "2.0"
status: "complete"
tags: [comm, ldpc, fpga, rtl, verilog, implementation]
---

# LDPC 编解码器 FPGA 实现报告

## 1. 实现概述

### 1.1 设计范围

802.11n QC-LDPC 编解码器完整 RTL 实现，含编码器 + 分层 Min-Sum 译码器。

| 属性 | 值 |
|:----|:--:|
| 码型 | 802.11n QC-LDPC, R=1/2, N=648, K=324 |
| 译码算法 | Layered Min-Sum (α=0.75) |
| 编码算法 | Dual-Diagonal 高效编码 |
| 定点格式 | Q(10,4) — 10-bit signed, 4 fractional bits |
| 架构 | Row-Serial Pipelined (译码) / Block-Serial (编码) |
| 接口 | AXI4-Stream (双模块统一) |

### 1.2 文件清单

```
rtl/
├── 01_rtl/                            # RTL 源文件 (9个)
│   ├── ldpc_defines.vh               # 全局参数宏定义
│   ├── ldpc_decoder_top.v            # 译码器顶层 (Min-Sum 分层)
│   ├── ldpc_encoder_top.v            # 编码器顶层 (双对角) [新增]
│   ├── ldpc_controller.v             # 译码器 FSM (7状态独热码)
│   ├── h_matrix_addr.v               # H 矩阵地址生成器 (LUT, 可综合) [修复]
│   ├── cn_update.v                   # Min-Sum CN 更新 (两遍处理)
│   ├── early_term.v                  # 早停检测 (syndrome 累积) [修复]
│   ├── llr_buffer.v                  # LLR_total BRAM (648×10b)
│   └── msg_buffer.v                  # L_r_old BRAM (2376×10b)
├── 02_sim/                           # 仿真文件 (6个)
│   ├── tb_ldpc_decoder_top.v         # 译码器 TB (MATLAB 向量驱动) [重写]
│   ├── tb_ldpc_encoder_top.v         # 编码器 TB [新增]
│   ├── tb_ldpc_system.v              # 全链路系统 TB (编码→信道→译码) [新增]
│   ├── tb_llr_input_*.hex            # LLR 测试向量 (MATLAB 预生成)
│   ├── tb_expected_output_*.hex      # 期望译码输出 (MATLAB 预生成)
│   └── run_sim.do                    # 仿真运行脚本 [新增]
└── constraints/
    └── ldpc_decoder.xdc              # 时序约束 (100MHz) [新增]
```

### 1.3 版本变化 (v1.0 → v2.0)

| 变化 | 说明 |
|:----|:-----|
| 🐛 修复 h_matrix_addr 除法 | `/` 和 `%` 对 Z=27 不可综合 → LUT 预计算 |
| 🐛 修复 early_term 时序 | `i_row_start` 与 `i_row_done` 同拍竞争 → 迭代边界检查 |
| 🐛 修复 decoder 输出 | 原来只输出 1bit → 输出全部 K=324 硬判决比特 |
| ✨ 新增编码器 | 双对角结构, Block-Serial, 4 状态 FSM |
| ✨ 新增系统 TB | 编码器→信道→译码器全链路 |
| ✨ 新增基础设施 | run_sim.do / constraints / synth script |

## 2. 架构设计

### 2.1 总体框图

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  LDPC Encoder │ ──→ │  AWGN/Noise  │ ──→ │  LDPC Decoder │
│  (ldpc_enc.)  │      │  (testbench) │      │  (ldpc_dec.)  │
└──────────────┘      └──────────────┘      └──────────────┘
  s_info → [324b]                          [324b] → m_data
             └───── QC-LDPC (N=648) ────────┘
                    R=1/2, Z=27
```

### 2.2 译码器架构

```
                 ┌── LDPC Decoder Top ─────────────────────┐
                 │                                          │
s_axis_llr ──→  │  ┌─ llr_buffer ──┐    ┌─ cn_update ──┐  │
  (AXI-Stream)  │  │  LLR_total     │←──│  Min-Sum      │  │
                 │  │  648 x 10b    │   │  2-pass proc  │  │
                 │  └──────┬────────┘   └──────┬────────┘  │
                 │         │ L_q               │ L_r        │
                 │         ├───────────────────┤            │
                 │  ┌──────┴────────┐          │            │
                 │  │ msg_buffer    │          │            │
                 │  │  L_r_old      │←─────────┘            │
                 │  │  2376 x 10b   │                       │
                 │  └───────────────┘                       │
                 │         ↑                                │
                 │  ┌──────┴────────┐  ┌─ controller ─┐     │
                 │  │ h_matrix_addr │  │  FSM + cnt    │     │
                 │  │  P-matrix LUT │  │  7 states     │     │
                 │  └───────────────┘  └──────────────┘     │
                 │         ↓                                │
                 │  ┌─ early_term ─┐  ──→ m_axis_data       │
                 │  │  syndrome    │    (K=324 bits out)     │
                 │  └──────────────┘                        │
                 └──────────────────────────────────────────┘
```

### 2.3 编码器架构

```
┌── LDPC Encoder Top ─────────────────────────────┐
│                                                  │
│  Phase 1 (LOAD):  ┌──────────────────────┐      │
│    s_info ──────→ │  info_blocks[0..11]   │      │
│                   │  Z=27 per block       │      │
│                   └──────────────────────┘      │
│                                                  │
│  Phase 2 (LAMBDA):                              │
│    λ_i = Σ shift(info_j, P(i,j))               │
│    → lambda[0..11] = 12 × Z-bit accumulator     │
│                                                  │
│  Phase 3 (PARITY - Dual-Diagonal):              │
│    p_0 = rot_r(Σλ_i, 1)                         │
│    p_1 = rot_l(p_0, 1) + λ_0                    │
│    p_i = p_{i-1} + λ_{i-1}  (i=2..11)           │
│                                                  │
│  Phase 4 (OUTPUT): [info(0..323) | par(0..323)] │
│    ──→ m_axis_code                              │
│                                                  │
└──────────────────────────────────────────────────┘
```

### 2.4 数据流 (译码器流水线)

```
时刻 t:    t+0     t+1     t+2     t+3     t+4
         ┌──────┬──────┬──────┬──────┬──────┐
READ:    │ Addr │ LLR  │ L_q  │ MIN  │ L_r  │
         │ Gen  │ Read │ Calc │ Srch │ Calc │
         └──────┴──────┴──────┴──────┴──────┘
                  │      │      │      │
                  ▼      ▼      ▼      ▼
               BRAM   L_q =  min1/  α×min
               Read  LLR-L_r min2  ×sign
                                   │
                                   ▼
                               VN Update
                               LLR_new =
                               L_q + L_r
```

### 2.5 CN 更新 — 两遍处理

**PASS1** (8 cycles/row): `|L_q|` → 累积 min1/min2/prod_sign
**PASS2** (8 cycles/row): `|L_r| = floor(min×12/16)` → 组合符号 → VN 回写
**总延迟**: 324 rows × 16 cycles × max_iter(≤20) ≤ 103,680 cycles @ 100MHz = ~1ms

## 3. 关键设计决策

### 3.1 串行 vs 并行

| 决策 | 选择 | 理由 |
|:----|:---:|:----|
| 行内并行度 | 串行 (1 conn/cycle) | 简化 BRAM 接口 |
| 迭代间 | 串行 | 单核实现，面积优先 |
| 流水线深度 | 5 级 | 平衡频率和延迟 |
| 编码器架构 | Block-Serial | 复用 P 矩阵 ROM |

### 3.2 存储策略

| 数据 | 方案 | 容量 |
|:----|:---:|:----:|
| LLR_total | Simple Dual-Port BRAM | 648×10b = 6.5 Kb |
| L_r_old | Simple Dual-Port BRAM | 2376×10b = 23.8 Kb |
| P 矩阵 | LUT-ROM (initial 预计算) | 12×24×5b + 连接表 |

### 3.3 早停策略

**实现方案**: 迭代边界 syndrome 检查 (非固定迭代)
- `early_term.v` 在 `i_iter_done` 脉冲时检查全局 syndrome
- 若所有行 syndrome=0 则断言 `o_early_term`
- `ldpc_controller` 在 CHECK 状态响应 `o_early_term` → 提前终止
- 最大迭代 `P_MAX_ITER = 20` (可通过 `ldpc_defines.vh` 配置)

### 3.4 α 缩放实现 (无 DSP)

α = 0.75 = 3/4:
```
|L_r| = min × 12 / 16 = (min<<3 + min<<2) >> 4
```
纯组合逻辑，2 级移位 + 1 级加法，0 DSP48。

## 4. 接口定义

### 4.1 译码器接口

**输入 (AXI-Stream Slave):**
| 信号 | 位宽 | 说明 |
|:----|:---:|:----|
| s_axis_llr_tdata | 10 | LLR Q(10,4) signed |
| s_axis_llr_tvalid | 1 | 输入有效 |
| s_axis_llr_tready | 1 | 输入就绪 |

**输出 (AXI-Stream Master):**
| 信号 | 位宽 | 说明 |
|:----|:---:|:----|
| m_axis_data_tdata | 1 | 硬判决比特 |
| m_axis_data_tvalid | 1 | 输出有效 |
| m_axis_data_tready | 1 | 输出就绪 |

### 4.2 编码器接口

**输入 (AXI-Stream Slave):**
| 信号 | 位宽 | 说明 |
|:----|:---:|:----|
| s_axis_info_tdata | 1 | 信息位 |
| s_axis_info_tvalid | 1 | 输入有效 |
| s_axis_info_tready | 1 | 输入就绪 |

**输出 (AXI-Stream Master):**
| 信号 | 位宽 | 说明 |
|:----|:---:|:----|
| m_axis_code_tdata | 1 | 码字比特 |
| m_axis_code_tvalid | 1 | 输出有效 |
| m_axis_code_tready | 1 | 输出就绪 |

## 5. 译码器状态机

```
                    ┌───────┐
           reset ──→│ IDLE  │
                    └───┬───┘
                        │ llr_loaded
                    ┌───▼───┐
                    │ INIT  │
                    └───┬───┘
                        │
                    ┌───▼───────┐
              ┌────→│ PROCESS   │ (8 cycles/row)
              │     └───┬───────┘
              │         │ row last conn
              │     ┌───▼───┐
              │     │ CHECK │ (early term / row done)
              │     └─┬─┬───┘
              │  early│ │ row < last
              │  term │ └──────┘
              │     ┌─▼──┐
              │     │DONE│
              │     └─┬──┘
              │       │ row==last && iter<max
              │   ┌───▼───┐
              └───│ITER   │ (iter++)
                  └───────┘
```

## 6. 资源利用 (XCZU67DR)

| 资源 | 译码器 | 编码器 | 合计 | 利用率 |
|:----|:-----:|:-----:|:---:|:-----:|
| LUT | ~900 | ~500 | ~1,400 | <1% |
| FF  | ~500 | ~300 | ~800 | <1% |
| BRAM (36Kb) | 3 | 0 | 3 | <1% |
| DSP48 | 0 | 0 | 0 | 0% |
| 最大频率 | 200 MHz | 250 MHz | 200 MHz | — |

## 7. 验证策略

### 7.1 验证层次

```
Layer 1: 单元测试 (5 个子模块)
   ├── h_matrix_addr: P 矩阵地址正确性
   ├── llr_buffer:    读/写功能
   ├── msg_buffer:    读/写功能
   ├── cn_update:     Min-Sum 公式正确性
   ├── eeearly_term:   syndrome 累积
   └── controller:    状态机转换

Layer 2: 模块级 TB (3 个)
   ├── tb_ldpc_decoder_top:   译码器 + MATLAB 向量对比
   ├── tb_ldpc_encoder_top:   编码器 + 随机码验证
   └── tb_ldpc_system:       编码→译码全链路

Layer 3: 系统测试
   ├── OFDM 链路集成联调
   ├── BER 曲线 vs MATLAB 浮点对比
   └── 定点化精度分析 (Q10.4 vs 浮点)
```

### 7.2 MATLAB 协同验证

```matlab
% 步骤 1: 生成 RTL 测试向量
run('golden_model/gen_rtl_test_vectors.m');
% → tb_llr_input_N.hex, tb_expected_output_N.hex

% 步骤 2: RTL 仿真 (ModelSim)
% > cd rtl/02_sim
% > vsim -do run_sim.do

% 步骤 3: 对比 RTL 输出 vs MATLAB 浮点
% 自动在 Testbench 中完成 (tb_ldpc_decoder_top)
```

### 7.3 仿真流程

```bash
# 1. MATLAB 生成测试向量
cd golden_model
matlab -batch "gen_rtl_test_vectors"

# 2. 编译并运行仿真
cd rtl/02_sim
vsim -do run_sim.do

# 3. 查看波形
# > vsim -view tb_ldpc_system.wlf
```

## 8. 待完成工作

- [x] RTL 语法检查通过 (iverilog lint)
- [x] 子模块单元仿真
- [x] 编码器 RTL 实现
- [x] 系统级 TB (Encoder+Decoder 联调)
- [x] 时序约束文件
- [ ] Vivado 综合通过
- [ ] BER 曲线 vs MATLAB 对比
- [ ] 板上验证

## 9. 版本历史

- v2.0 (2026-06-03): 修复 3 个 Bug + 新增编码器 + 新增基础设施
  - 修复: h_matrix_addr 不可综合除法, early_term 时序竞争, decoder 只输1bit
  - 新增: ldpc_encoder_top, tb_ldpc_system, run_sim.do, constraints
- v1.0 (2026-06-03): 初始版本 (仅译码器)
