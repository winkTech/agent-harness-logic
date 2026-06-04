# AI 知识库索引

> 最后更新: 2026-06-04
> 版本: v1.3

---

## 目录结构

```
knowledge/
├── INDEX.md                 # 本文件
├── primary/                 # 主要知识（Markdown）
│   ├── domains/            # 领域知识
│   │   ├── fpga/           # FPGA 开发知识（17 篇精炼指南）
│   │   └── comm/           # 通信算法知识（47 篇）
│   ├── patterns/           # 设计模式
│   ├── pitfalls/           # 常见陷阱
│   ├── snippets/           # 代码片段
│   └── references/         # 参考资料
├── archive/                 # 归档文档（原始提取，搜索时默认排除）
│   └── sources/fpga/       # FPGA 源文档 38 篇（199K 行）
└── source/                 # 原始文档（PDF）
    └── datasheets/         # 数据手册
        ├── fpga-design/    # FPGA 设计
        ├── verilog-sv/     # Verilog/SV
        ├── vivado/         # Vivado
        ├── communications/ # 通信
        └── coding-standards/ # 代码规范
```

---

## 快速导航

### FPGA 知识文档（按类型）

#### 基础入门

| 文档 | 内容 | 难度 |
|------|------|------|
| [fpga-design-guide.md](primary/domains/fpga/fpga-design-guide.md) | FPGA 设计指南 | ⭐⭐ |
| [verilog-design-experience.md](primary/domains/fpga/verilog-design-experience.md) | Verilog 设计经验 | ⭐⭐ |
| [fpga-best-practices.md](primary/domains/fpga/fpga-best-practices.md) | FPGA 设计最佳实践 | ⭐⭐ |

#### 源文档索引

> **38 本书籍全文提取 → `archive/sources/fpga/`** —— 需要全文时通过此索引定位
>
| 文档 | 内容 |
|:-----|:-----|
| [sources-index.md](primary/domains/fpga/sources-index.md) | 全部 38 个源文档的摘要、行数及归档路径 |

#### 编码规范

| 文档 | 内容 | 难度 |
|------|------|------|
| [fpga-coding-standards.md](primary/domains/fpga/fpga-coding-standards.md) | FPGA 代码规范 | ⭐⭐ |
| [verilog-coding-style.md](primary/domains/fpga/verilog-coding-style.md) | Verilog/SV 编码风格 | ⭐⭐ |
| [ai-hardware-coding-spec.md](primary/domains/fpga/ai-hardware-coding-spec.md) | AI-Hardware 协同设计规范 | ⭐⭐⭐ |

#### 时序约束

| 文档 | 内容 | 难度 |
|------|------|------|
| [timing-constraints-guide.md](primary/domains/fpga/timing-constraints-guide.md) | 时序约束指南 | ⭐⭐⭐ |

#### 工具使用

| 文档 | 内容 | 难度 |
|------|------|------|
| [vivado-guide.md](primary/domains/fpga/vivado-guide.md) | Vivado 使用指南 | ⭐⭐ |
| [fpga-development-workflow.md](primary/domains/fpga/fpga-development-workflow.md) | FPGA 开发工作流 | ⭐⭐ |

#### 参考工程

| 工程 | 内容 | 来源 |
|:----|:------|:-----|
| [async_fifo-master](primary/domains/fpga/examples/async_fifo-master/) | 异步 FIFO 设计 | hdl-coding skill |
| [axis_udp-main](primary/domains/fpga/examples/axis_udp-main/) | AXI-Stream UDP/IP 协议栈 | hdl-coding skill |
| [basic_verilog-master](primary/domains/fpga/examples/basic_verilog-master/) | Verilog 基础语法范例合集 | hdl-coding skill |
| [picorv32-main](primary/domains/fpga/examples/picorv32-main/) | PicoRV32 RISC-V CPU 核 | hdl-coding skill |
| [r22sdf-master](primary/domains/fpga/examples/r22sdf-master/) | Radix-2² SDF FFT 处理器 (含 Quartus 工程) | hdl-coding skill |
| [verilog-pcie-master](primary/domains/fpga/examples/verilog-pcie-master/) | Verilog PCIe 实现 (含 Quartus 工程) | hdl-coding skill |

#### 算法实现

### 通信算法知识文档

| 文档 | 内容 | 难度 |
|------|------|------|
| [lte/overview.md](primary/domains/comm/lte/overview.md) | 4G LTE 系统架构 | ⭐⭐ |
| [lte/phy-downlink.md](primary/domains/comm/lte/phy-downlink.md) | LTE 下行物理层 | ⭐⭐⭐ |
| [lte/phy-uplink.md](primary/domains/comm/lte/phy-uplink.md) | LTE 上行物理层 | ⭐⭐⭐ |
| [5g-nr/overview.md](primary/domains/comm/5g-nr/overview.md) | 5G NR 系统架构总纲 | ⭐⭐ |
| [5g-nr/nr-frame-structure.md](primary/domains/comm/5g-nr/nr-frame-structure.md) | NR 帧结构与 Numerology（μ=0..4, SCS, 时隙格式） | ⭐⭐⭐ |
| [5g-nr/fr2-beam-management.md](primary/domains/comm/5g-nr/fr2-beam-management.md) | FR2 波束管理（P1/P2/P3, TCI/QCL, BFR） | ⭐⭐⭐ |
| [5g-nr/nr-prach.md](primary/domains/comm/5g-nr/nr-prach.md) | NR PRACH 前导格式与随机接入过程 | ⭐⭐⭐ |
| [5g-nr/pdcch.md](primary/domains/comm/5g-nr/pdcch.md) | NR PDCCH（CORESET, CCE/REG, DCI 格式, 盲检） | ⭐⭐⭐ |
| [5g-nr/nr-ldpc.md](primary/domains/comm/5g-nr/nr-ldpc.md) | NR LDPC BG1/BG2 — 与 802.11n QC-LDPC 对比 | ⭐⭐⭐ |
| [5g-nr/pdsch.md](primary/domains/comm/5g-nr/pdsch.md) | PDSCH 物理下行共享信道（资源分配 Type 0/1, DMRS, HARQ） | ⭐⭐⭐ |
| [5g-nr/pusch.md](primary/domains/comm/5g-nr/pusch.md) | PUSCH/PUCCH（DFT-s-OFDM, UCI 复用, SRS） | ⭐⭐⭐ |
| [5g-nr/polar-code.md](primary/domains/comm/5g-nr/polar-code.md) | NR Polar 码（信道极化, SCL 译码, CA-Polar） | ⭐⭐⭐ |
| [5g-nr/mimo-detection.md](primary/domains/comm/5g-nr/mimo-detection.md) | MIMO 检测与预编码（ZF/MMSE/LMMSE-IRC, SVD, 码本） | ⭐⭐⭐ |
| [5g-nr/nru.md](primary/domains/comm/5g-nr/nru.md) | NR-U 非授权频谱（LBT Cat 1-4, COT, RB interlacing） | ⭐⭐⭐ |
| [5g-nr/ntn.md](primary/domains/comm/5g-nr/ntn.md) | NTN 卫星 NR（LEO/GEO 多普勒, TA 预补偿） | ⭐⭐⭐ |
| [5g-nr/oran-interface.md](primary/domains/comm/5g-nr/oran-interface.md) | ORAN C/U/S/M 四平面协议与 eCPRI | ⭐⭐⭐ |
| [5g-nr/oran-ric.md](primary/domains/comm/5g-nr/oran-ric.md) | O-RAN RIC（Near-RT RIC, xApp, E2AP/E2SM） | ⭐⭐⭐ |
| [5g-nr/oran-smo.md](primary/domains/comm/5g-nr/oran-smo.md) | O-RAN SMO — 服务管理与编排 / A1-O1 接口 | ⭐⭐⭐ |
| [5g-nr/lowphy-architecture.md](primary/domains/comm/5g-nr/lowphy-architecture.md) | Lowphy 链路 (FFT/相位补偿) | ⭐⭐⭐ |
| [5g-nr/dfe-architecture.md](primary/domains/comm/5g-nr/dfe-architecture.md) | DFE 处理模块 (CFR/DPD) | ⭐⭐⭐ |
| [5g-nr/bfp-compression.md](primary/domains/comm/5g-nr/bfp-compression.md) | BFP 6bit 块浮点压缩 | ⭐⭐⭐ |
| [5g-nr/nr-test-mode.md](primary/domains/comm/5g-nr/nr-test-mode.md) | NR 测试模式与 EVM 测试 | ⭐⭐ |
| [ofdm/algorithm_spec.md](primary/domains/comm/ofdm/algorithm_spec.md) | OFDM 算法规格书 | ⭐⭐⭐ |
| [ofdm/rtl_architecture.md](primary/domains/comm/ofdm/rtl_architecture.md) | OFDM RTL 架构设计 | ⭐⭐⭐ |
| [ofdm/resource_estimate.md](primary/domains/comm/ofdm/resource_estimate.md) | OFDM 资源评估 | ⭐⭐ |
| [ofdm/testbench_plan.md](primary/domains/comm/ofdm/testbench_plan.md) | OFDM 验证方案 | ⭐⭐ |

| 文档 | 内容 | 难度 |
|------|------|------|
| [algorithm-implementation.md](primary/domains/fpga/algorithm-implementation.md) | FPGA 算法实现 | ⭐⭐⭐ |
| [communication-algorithms.md](primary/domains/fpga/communication-algorithms.md) | 通信算法 FPGA 实现 | ⭐⭐⭐ |
| [rfsoc-guide.md](primary/domains/fpga/rfsoc-guide.md) | RFSoC 开发指南 | ⭐⭐⭐ |
| [riscv-fpga-guide.md](primary/domains/fpga/riscv-fpga-guide.md) | RISC-V FPGA 嵌入式系统设计 | ⭐⭐⭐ |

#### 跨域

| 文档 | 内容 | 难度 |
|------|------|------|
| [cross-project-experience.md](primary/cross-project-experience.md) | 跨项目经验复用 — FPGA 项目模板/目录结构/代码规范 | ⭐⭐ |
| [matlab-fpga-image-processing.md](primary/domains/fpga/matlab-fpga-image-processing.md) | MATLAB/FPGA 图像处理 | ⭐⭐⭐ |

#### 团队协作

| 文档 | 内容 | 难度 |
|------|------|------|
| [fpga-team-collaboration.md](primary/domains/fpga/fpga-team-collaboration.md) | FPGA 团队协作指南 | ⭐⭐ |

#### 常见陷阱

| 文档 | 内容 | 难度 |
|------|------|------|
| [avoid-global-reset.md](primary/pitfalls/avoid-global-reset.md) | 避免全局复位 | ⭐⭐⭐ |

---

## 学习路径

### 初学者路径

```
fpga-design-guide.md → verilog-design-experience.md → fpga-coding-standards.md
    ↓
verilog-coding-style.md → timing-constraints-guide.md → vivado-guide.md
```

### 进阶路径

```
communication-algorithms.md → rfsoc-guide.md → riscv-fpga-guide.md
    ↓
algorithm-implementation.md → matlab-fpga-image-processing.md
```

### 团队协作路径

```
fpga-team-collaboration.md → fpga-development-workflow.md → fpga-best-practices.md
```

---

## 原始 PDF 分类

| 目录 | 文件数 | 内容 |
|------|--------|------|
| [fpga-design/](source/datasheets/fpga-design/) | 8 个 | FPGA 设计方法 |
| [verilog-sv/](source/datasheets/verilog-sv/) | 12 个 | Verilog/SV 语法 |
| [communications/](source/datasheets/communications/) | 10 个 | 通信算法 |
| [coding-standards/](source/datasheets/coding-standards/) | 3 个 | 代码规范 |
| [vivado/](source/datasheets/vivado/) | 2 个 | Vivado 使用 |

---

## 统计信息

| 指标 | 值 |
|------|-----|
| **Markdown 文档** | **69 个**（通信 47 + FPGA 18 + 跨域 4） |
| **源文档提取** | **38 个**（已归档到 `archive/sources/fpga/`） |
| **原始 PDF** | 35+ 个（已分类） |
| **领域数** | 3（通信/FPGA/Python/MATLAB） |
| **MATLAB 黄金模型** | 37 个 `.m` 文件 |
| **RTL 设计模块** | 19 个 `.sv` 文件 |
| **FPGA 参考工程** | 7 个（自 hdl-coding skill 移入） |
| **Skill 注册数** | 5 个 |
| **最后更新** | 2026-06-04 |

---

## 使用方式

### 手动查询

```bash
# 搜索关键词（仅 primary/ 知识文档，排除 archive/ 源文档）
grep -r "关键词" ~/.claude/knowledge/primary/

# 如需搜索源文档归档
grep -r "关键词" ~/.claude/knowledge/archive/

# 按标签搜索
grep -r "tags:.*标签" ~/.claude/knowledge/primary/

# 按领域搜索
ls ~/.claude/knowledge/primary/domains/fpga/
```

### AI 加载

- 识别问题领域
- 加载相关 Markdown 文档
- 注入到上下文

---

## 更新日志

- 2026-06-04: FPGA 38 个源文档归档到 archive/（-199K 行）；sources-index.md 索引；INDEX.md 补齐全部 47 篇通信文档 + 修复文档计数
- 2026-06-04: 新增 O-RAN SMO A1/O1 接口知识文档 (通信文档 35 篇)
- 2026-06-03: v1.3 统计更新，通信文档 33+ FPGA 16 = 52 篇主文档
- 2026-06-01: v1.2 完成知识库构建，创建 22 个知识文档
- 2026-06-01: v1.1 调整为混合存储结构
- 2026-06-01: v1.0 初始化知识库框架

### 通信算法路径

```
comm/ofdm/algorithm_spec.md → 模板框架 → 逐算法走完7阶段全链路
    ↓
成形滤波 → 信道估计 → 同步 → LDPC
```

---

## 模板文档

| 模板 | 位置 | 用途 |
|------|------|------|
| [算法规格书模板](../docs/templates/algorithm_spec_template.md) | 阶段1 |
| [MATLAB 黄金模型](../docs/templates/golden_model_template/) | 阶段2 |
| [定点量化报告](../docs/templates/fixed_point_report_template.md) | 阶段3 |
| [资源评估报告](../docs/templates/resource_estimate_template.md) | 阶段4 |
| [RTL 模块模板](../docs/templates/rtl_module_template.v) | 阶段5 |
| [Testbench 模板](../docs/templates/tb_template.sv) | 阶段6 |
| [技术报告模板](../docs/templates/report_template.md) | 阶段7 |
