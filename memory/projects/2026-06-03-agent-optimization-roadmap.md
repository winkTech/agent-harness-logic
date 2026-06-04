---
name: agent-optimization-roadmap
description: 长期Agent优化计划，分3阶段6项任务，覆盖5G NR/Python调试/高速接口等
metadata:
  type: project
  priority: high
  due: 2026-07
---

# Agent 长期优化路线图

> 基于 [[agent-evaluation-v2]] 制定的 3 阶段优化计划

---

## 路线图总览

```
Phase 1 (本周)             Phase 2 (两周内)          Phase 3 (一个月内)
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ P0: 4G LTE 知识库 │ ──▶ │ P1: 高速接口知识库 │ ──▶ │ P2: Xilinx高阶   │
│ P0: 5G NR 知识库  │      │ P1: MATLAB贯通流程 │     │ P2: 验证方法论   │
│ P0: Python调试Skill│     │                  │     │                  │
└──────────────────┘      └──────────────────┘      └──────────────────┘
```

---

## Phase 1 — 立即执行（本周）

### 任务 1.1: 4G LTE + 5G NR 知识库构建

**目标**: 补齐蜂窝通信标准知识，LTE 做基础 → 5G NR 做当前工作覆盖

| 文档 | 内容 | 来源 |
|:----|:----|:----|
| `comm/lte/overview.md` | 4G LTE 系统架构（帧结构/物理资源/信道映射） | 标准+经验 |
| `comm/lte/phy-downlink.md` | LTE 下行物理层（OFDMA/PBCH/PDCCH/PDSCH/参考信号） | 标准 |
| `comm/lte/phy-uplink.md` | LTE 上行物理层（SC-FDMA/PRACH/PUCCH/PUSCH/SRS） | 标准 |
| `comm/5g-nr/oran-interface.md` | ORAN 同步接口协议 | 项目经验 |
| `comm/5g-nr/lowphy-architecture.md` | Lowphy 链路（FFT/IFFT/CP/相位补偿/交换） | 智慧尘埃 AAU 项目 |
| `comm/5g-nr/dfe-architecture.md` | DFE 处理模块（CFR/DPD 基础） | 项目经验 |
| `comm/5g-nr/bfp-compression.md` | BFP 6bit 块浮点压缩解压算法 | 智慧尘埃项目 |
| `comm/5g-nr/nr-test-mode.md` | 5G NR 下行测试模式（EVM 测试） | 智慧尘埃项目 |

**工作量**: 8 个文档，约 3-4 小时

#### LTE ↔ 5G NR 对照

| 维度 | 4G LTE | 5G NR |
|:----|:-------|:------|
| 波形 | OFDMA(DL) / SC-FDMA(UL) | CP-OFDM(DL+UL) / DFT-s-OFDM |
| 子载波间隔 | 固定 15kHz | 可变 15/30/60/120kHz (μ=0~3) |
| 帧长 | 10ms (10子帧) | 10ms (10子帧, 灵活slot) |
| 信道编码 | Turbo + 卷积码 | LDPC(数据) + Polar(控制) |
| MIMO | 最大 8×8 (LTE-A) | 最大 64×64 (Massive MIMO) |
| Lowphy | 标准 FFT/IFFT | FFT + 相位补偿 + 符号级交换 |

### 任务 1.2: Python 硬件调试 Skill 创建

**目标**: 将日常 Python 调试脚本能力沉淀为可复用的 Skill

| 模板 | 功能 | 触发词 |
|:----|:----|:-------|
| `constellation.py` | 星座图绘制（QPSK/8PSK/16QAM） | 画星座图 |
| `freq_estimate.py` | 频偏估计与补偿 | 估频偏 |
| `evm_calc.py` | EVM 计算（EVM vs SNR） | 算EVM |
| `data_capture.py` | 采数分析（ILA/CHIPSCOPE 数据解析） | 采数分析 |
| `ber_test.py` | BER 误码率统计与分析 | 测BER |
| `config_gen.py` | 寄存器配置脚本生成 | 配寄存器 |

**工作量**: 1个 Skill 定义 + 6个模板，约 2 小时

---

## Phase 2 — 两周内执行

### 任务 2.1: 高速接口调试知识库

**目标**: 沉淀多年调试经验

| 文档 | 内容 |
|:----|:----|
| `fpga/high-speed-if/jesd204b-debug.md` | JESD204B 链路建立流程、ILA抓波技巧、常见错误码排查 |
| `fpga/high-speed-if/aurora-config.md` | Aurora 协议配置、核参数选择、调试点 |
| `fpga/high-speed-if/ddr4-mig-test.md` | DDR4 MIG 测试方案（ATG/矩阵转置/带宽验证） |
| `fpga/high-speed-if/gty-transceiver.md` | GTY 高速收发器跨Qaud配置、线速率匹配 |
| `fpga/high-speed-if/chip2chip.md` | Chip2Chip 片间通信方案设计与验证 |
| `fpga/high-speed-if/pcie-xdma.md` | PCIE XDMA 驱动与逻辑协同调试 |

**工作量**: 6 个文档，约 3-4 小时

### 任务 2.2: MATLAB → RTL 贯通工作流

**目标**: 从当前的"各自独立"升级为"无缝贯通"

| 优化项 | 当前 | 目标 |
|:-------|:----|:-----|
| golden model 模板 | 通用模板 | 通信物理层专用模板（Tx+Rx 全链路） |
| 测试向量生成 | 手动 | 自动生成 .hex/.coe 测试向量 |
| co-sim 对比 | 手动 | 自动化 RTL 输出 vs golden model 对比脚本 |
| 定点化流程 | 半自动 | 一键定点化精度分析 + 报告 |

**工作量**: 模板改造 + 自动化脚本，约 3-4 小时

---

## Phase 3 — 一个月内执行

### 任务 3.1: Xilinx 高阶技巧知识库

| 文档 | 内容 |
|:----|:----|
| `fpga/xilinx-advanced/selectmap-loading.md` | SelectMap/Slave_SelectMap 在线加载协议 |
| `fpga/xilinx-advanced/vivado-tcl-automation.md` | Vivado Tcl 自动化脚本（编译/调试/报告） |
| `fpga/xilinx-advanced/timing-closure.md` | 高速设计时序收敛方法论 |
| `fpga/xilinx-advanced/rfsoc-best-practices.md` | RFSoC (zu67dr) 开发最佳实践 |

### 任务 3.2: 端到端物理层验证方法论

| 文档 | 内容 |
|:----|:----|
| `comm/verification/phy-link-level-test.md` | 物理层全链路联调检查清单 |
| `comm/verification/common-issues-troubleshooting.md` | 常见问题排查决策树 |
| `comm/verification/python-matlab-co-sim.md` | Python + MATLAB 联合调试工作流 |

---

## 进度追踪

```
Phase 1: [██████████] 100% ✅
  ├─ ✅ 1.1 4G LTE + 5G NR 知识库 (8篇文档)
  │   ├─ LTE: overview, phy-downlink, phy-uplink
  │   └─ NR: oran-interface, lowphy-architecture, dfe-architecture, bfp-compression, nr-test-mode
  └─ ✅ 1.2 Python 调试 Skill + 6模板
      ├─ SKILL.md + constellation/freq_estimate/evm_calc/data_capture/ber_test/config_gen

Phase 2: [▱▱▱▱▱▱▱▱▱▱] 0%  {下阶段启动}
  ├─ 2.1 高速接口知识库    [▱▱▱▱▱▱▱▱▱▱]
  └─ 2.2 MATLAB-RTL 贯通   [▱▱▱▱▱▱▱▱▱▱]

Phase 3: [▱▱▱▱▱▱▱▱▱▱] 0%
  ├─ 3.1 Xilinx 高阶技巧   [▱▱▱▱▱▱▱▱▱▱]
  └─ 3.2 端到端验证方法论   [▱▱▱▱▱▱▱▱▱▱]
```

## 相关记忆

- [[agent-evaluation-v2]] — 评估结果明细
- 历史: `memory/work/2026-06-02-知识库构建.md` — 知识库构建方法
- 历史: `memory/work/2026-06-02-Agent优化.md` — 配置优化方法
