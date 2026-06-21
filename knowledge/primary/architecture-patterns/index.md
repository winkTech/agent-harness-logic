# 架构模式库 (Architecture Pattern Library)

> 本库为逻辑工程师提供 B1 架构空间探索环节所需的**定量对比数据**，
> 让微架构选型有据可查，不凭感觉。
>
> 每个模式给出至少 2 种实现选项的面积/延迟/吞吐/Fmax 对比数据，
> 以及选型决策树。

---

## 模式索引

| 类别 | 模式 | 文件 | 典型使用场景 |
|:-----|:-----|:-----|:-------------|
| **DSP** | FIR 滤波器 | `dsp-architectures.md` | 信道匹配滤波、脉冲成型、信道估计 |
| **DSP** | CORDIC | `dsp-architectures.md` | 三角函数、极坐标转换、频偏估计 |
| **DSP** | FFT | `dsp-architectures.md` | OFDM 解调、信道估计、频谱分析 |
| **DSP** | 复乘 | `dsp-architectures.md` | 混频、相位旋转、均衡 |
| **DSP** | MAC/乘累加 | `dsp-architectures.md` | 自适应滤波、矩阵运算 |
| **存储** | FIFO | `memory-cdc-patterns.md` | 跨时钟域缓冲、速率匹配 |
| **CDC** | 同步器 | `memory-cdc-patterns.md` | 单/多 bit 跨时钟域传输 |
| **CDC** | 异步 FIFO | `memory-cdc-patterns.md` | 多 bit 跨时钟域数据流 |
| **控制** | 背压管理 | `memory-cdc-patterns.md` | AXI-Stream 反压链设计 |
| **控制** | Pipeline 寄存器 | `memory-cdc-patterns.md` | 时序中断、流水线平衡 |

---

## 快速选型决策树

### 面积优先 → 时序优先

```
面积预算紧张？
├─ YES ── 是否可容忍多 cycle 延迟？
│          ├─ YES → 折叠式 (folded/time-shared)
│          └─ NO  → 半折叠 (semi-folded)
└─ NO ── 吞吐要求 > Fclk？
         ├─ YES → 全并行 (fully parallel) 或 脉动阵列 (systolic)
         └─ NO  → 半折叠或全流水线 (fully pipelined)
```

### 存储选型

```
FIFO 深度 ≤ 16?
├─ YES → 寄存器 (Register-based, 零 BRAM)
└─ NO  ── 深度 ≤ 64?
          ├─ YES → Distributed RAM (LUTRAM, 零 BRAM)
          └─ NO  → Block RAM (BRAM)
                   └─ 深度 > 36K → UltraRAM
```

### CDC 选型

```
单 bit 控制信号?
├─ YES ── 慢时钟域 → 快时钟域？
│          ├─ YES → 2 级同步器 (最少延迟)
│          └─ NO  → 3 级同步器 + 边沿检测 (防亚稳态)
└─ NO (多 bit 数据) ── 数据是否连续流?
                       ├─ YES → 异步 FIFO (握手+格雷码)
                       └─ NO  → 握手同步 (req/ack, 简单但慢)
```

---

## 使用方式

1. 在 B1 环节打开对应模式的文档
2. 根据系统约束（Fclk、吞吐、面积预算）查对比表
3. 选型后在 `architecture_tradeoff.md` 中记录选择理由
4. 将选定的资源消耗填入 B2 资源预算表
5. 将选定的 pipeline 级数填入 B3 时序预估表

---

## 数据来源说明

- DSP48/LUT/FF/BRAM 数据基于 **Xilinx 7-series / UltraScale+**
- Fmax 估算基于典型 28nm/20nm 工艺，实际以综合报告为准
- 资源估算是一阶(First-order)预估，综合结果 ±30% 以内
- **同一算法在不同 FPGA 系列上资源差异可达 2×** — 以实际器件手册为准

## 相关文件

- `skills/hdl-coding/templates/` — 可综合的 RTL 实现模板
- `skills/hdl-coding/references/fpga-optimization.md` — 资源优化技术
- `skills/hdl-coding/references/pipeline-templates.md` — 流水线模板
