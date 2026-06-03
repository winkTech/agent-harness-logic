---
algorithm: "LDPC FPGA Implementation"
version: "1.0"
status: "draft"
tags: [comm, ldpc, fpga, rtl, verilog, implementation]
---

# LDPC 译码器 FPGA 实现报告

## 1. 实现概述

### 1.1 设计范围

实现 802.11n QC-LDPC 译码器的可综合 RTL 设计，采用分层 Min-Sum 算法。

| 属性 | 值 |
|:----|:--:|
| 码型 | 802.11n QC-LDPC, R=1/2, N=648, K=324 |
| 算法 | Layered Min-Sum (α=0.75) |
| 定点格式 | Q(10,4) — 10-bit signed, 4 fractional bits |
| 架构 | 串行流水线 (Row-Serial Pipelined) |
| 接口 | AXI4-Stream (简化版) |

### 1.2 文件清单

```
knowledge/primary/domains/comm/ldpc/rtl/
├── 01_rtl/
│   ├── ldpc_defines.vh           — 全局参数宏定义
│   ├── ldpc_decoder_top.v        — 顶层模块
│   ├── ldpc_controller.v         — 主状态机
│   ├── h_matrix_addr.v           — H 矩阵地址生成器 (含 P 矩阵 ROM)
│   ├── llr_buffer.v              — LLR_total BRAM 封装
│   ├── msg_buffer.v              — L_r_old BRAM 封装
│   ├── cn_update.v               — Min-Sum CN 更新 (两遍处理)
│   └── early_term.v              — 早停检测 (syndrome 校验)
└── 02_sim/
    ├── tb_ldpc_decoder_top.v     — 顶层 Testbench
    ├── tb_llr_input_*.hex        — 测试 LLR 输入向量 (MATLAB 生成)
    └── tb_expected_output_*.hex  — 期望译码输出 (MATLAB 生成)
```

## 2. 架构设计

### 2.1 顶层框图

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
                 │  ┌──────┴────────┐                       │
                 │  │ h_matrix_addr │  ┌─ controller ─┐     │
                 │  │  P-matrix ROM │  │  FSM + cnt   │     │
                 │  │  addr gen     │  └──────────────┘     │
                 │  └───────────────┘                       │
                 │         ↓                                │
                 │  ┌─ early_term ─┐  ──→ m_axis_data      │
                 │  │  syndrome    │    (AXI-Stream)        │
                 │  └──────────────┘                       │
                 └──────────────────────────────────────────┘
```

### 2.2 数据流

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

### 2.3 CN 更新 — 两遍处理

**第一遍 (PASS1)**: 逐个连接处理 (8 cycles)
- 计算 L_q = LLR_total - L_r_old
- 缓存 L_q 值
- 累积 min1, min2 (绝对值最小和次小)
- 累积 prod_sign (所有符号的 XOR)

**第二遍 (PASS2)**: 逐个连接处理 (8 cycles)
- 选择 min1 或 min2 (当前连接对应 min1_idx 则用 min2)
- α 缩放: |L_r| = floor(min × 12 / 16) = (min×8 + min×4) >> 4
- 加符号: L_r = |L_r| × prod_sign × sign_self
- VN 更新: LLR_new = sat(L_q + L_r, -512, 511)

## 3. 关键设计决策

### 3.1 串行 vs 并行

| 决策 | 选择 | 理由 |
|:----|:---:|:----|
| 行内并行度 | 串行 (1 conn/cycle) | 简化 BRAM 接口、降低复杂度 |
| 迭代间 | 串行 | 单核实现，面积优先 |
| 流水线深度 | 5 级 | 平衡频率和延迟 |

### 3.2 存储策略

| 数据 | 方案 | 容量 |
|:----|:---:|:----:|
| LLR_total | 1 × Simple Dual-Port BRAM | 648 × 10b = 6.5 Kb |
| L_r_old | 1 × Simple Dual-Port BRAM | 2376 × 10b = 23.8 Kb |
| P 矩阵 | 组合逻辑 LUT-ROM | 12×24×5b = 1.4 Kb |

### 3.3 早停策略

采用固定迭代次数 (max_iter=8)，不使用早停。理由：
- 早停需要额外 syndrome 检查逻辑
- 固定迭代便于时序分析和流水线优化
- 在目标 SNR 下，平均 4 次迭代即可收敛

### 3.4 α 缩放实现

α = 0.75 = 3/4：

```
|L_r| = (min × 12) >> 4
      = (min × 8 + min × 4) >> 4
      = ((min << 3) + (min << 2)) >> 4
```

- 纯组合逻辑，无乘法器
- 2 级移位 + 1 级加法
- 11-bit 中间精度

## 4. 接口定义

### 4.1 输入端口 (AXI-Stream Slave)

| 信号 | 位宽 | 方向 | 说明 |
|:----|:---:|:----:|:----|
| s_axis_llr_tdata | 10 | I | LLR 输入 (Q(10,4) signed) |
| s_axis_llr_tvalid | 1 | I | 输入有效 |
| s_axis_llr_tready | 1 | O | 输入就绪 |

### 4.2 输出端口 (AXI-Stream Master)

| 信号 | 位宽 | 方向 | 说明 |
|:----|:---:|:----:|:----|
| m_axis_data_tdata | 1 | O | 译码比特 (0/1) |
| m_axis_data_tvalid | 1 | O | 输出有效 |
| m_axis_data_tready | 1 | I | 输出就绪 |

### 4.3 时钟和复位

| 信号 | 位宽 | 方向 | 说明 |
|:----|:---:|:----:|:----|
| i_clk_sys | 1 | I | 系统时钟 (100-200 MHz) |
| i_rst_sys | 1 | I | 同步复位 (高有效) |

## 5. 状态机

```
                    ┌───────┐
           reset ──→│ IDLE  │
                    └───┬───┘
                        │ llr_loaded
                    ┌───▼───┐
                    │ INIT  │ (清零内部状态)
                    └───┬───┘
                        │
                    ┌───▼───────┐
              ┌────→│ PROCESS   │ (8 cycles/row)
              │     └───┬───────┘
              │         │ conn == MAX_ROW_WT-1
              │     ┌───▼───┐
              │     │ CHECK │ (syndrome check)
              │     └─┬─┬───┘
              │   early│ │ row < 324
              │   term │ └──────┘
              │     ┌─▼──┐
              │     │DONE│ (输出译码比特)
              │     └─┬──┘
              │       │ row == 324 && iter < max
              │   ┌───▼───┐
              └───│ITER   │ (iter++)
                  └───────┘
```

## 6. 资源利用

| 资源 | 预估 | 说明 |
|:----|:---:|:----|
| LUT | ~900 | 比较器、加法器、控制逻辑 |
| FF | ~500 | 流水线寄存器、计数器 |
| BRAM (36Kb) | 3 | LLR_total, L_r_old, 行连接表 |
| DSP | 0 | α 缩放用移位加法 |
| 最大频率 | 200 MHz | 5 级流水线 |

## 7. 验证策略

### 7.1 验证层次

```
Layer 1: 单元测试 (每个子模块独立验证)
   ├── h_matrix_addr: P 矩阵地址正确性
   ├── llr_buffer:    读/写功能
   ├── msg_buffer:    读/写功能
   ├── cn_update:     Min-Sum 公式正确性
   └── controller:    状态机转换正确性

Layer 2: 集成测试 (顶层模块)
   ├── 全零码字测试 (无噪声)
   ├── 随机码字测试 (MATLAB golden model 对比)
   └── 迭代收敛测试

Layer 3: 系统测试 (与其他模块联调)
   └── OFDM 链路集成
```

### 7.2 MATLAB 协同验证

1. MATLAB 生成测试向量 (LLR 输入 + 期望输出)
2. Verilog testbench 读取向量文件
3. 运行仿真，比较 RTL 输出与期望输出
4. 统计误码率，与浮点 MATLAB 对比

```matlab
% 生成测试向量
run('golden_model/gen_rtl_test_vectors.m');
% → 输出 tb_llr_input_*.hex, tb_expected_output_*.hex

% Verilog 仿真
% $ vlog rtl/01_rtl/*.v rtl/02_sim/tb_ldpc_decoder_top.v
% $ vsim -c -do "run -all; quit -f" tb_ldpc_decoder_top
```

## 8. 待完成工作

- [ ] RTL 语法检查通过 (vlog -lint)
- [ ] 子模块单元仿真通过
- [ ] 顶层集成仿真通过 (MATLAB 对比)
- [ ] Vivado 综合通过
- [ ] 时序约束添加
- [ ] 板上验证 (可选)

## 9. 版本历史

- v1.0 (2026-06-03): 初始版本
