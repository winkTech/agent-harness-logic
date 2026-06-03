# AI 知识库索引

> 最后更新: 2026-06-01
> 版本: v1.2

---

## 目录结构

```
knowledge/
├── INDEX.md                 # 本文件
├── primary/                 # 主要知识（Markdown）
│   ├── domains/            # 领域知识
│   │   ├── fpga/           # FPGA 开发知识
│   │   └── comm/           # 通信算法知识
│   ├── patterns/           # 设计模式
│   ├── pitfalls/           # 常见陷阱
│   ├── snippets/           # 代码片段
│   └── references/         # 参考资料
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

#### 算法实现

### 通信算法知识文档


| 文档 | 内容 | 难度 |
|------|------|------|
| [lte/overview.md](primary/domains/comm/lte/overview.md) | 4G LTE 系统架构 | ⭐⭐ |
| [lte/phy-downlink.md](primary/domains/comm/lte/phy-downlink.md) | LTE 下行物理层 | ⭐⭐⭐ |
| [lte/phy-uplink.md](primary/domains/comm/lte/phy-uplink.md) | LTE 上行物理层 | ⭐⭐⭐ |
| [5g-nr/oran-interface.md](primary/domains/comm/5g-nr/oran-interface.md) | ORAN 同步接口协议 | ⭐⭐⭐ |
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
| **Markdown 文档** | 24 个 |
| **源文档提取** | 34 个 |
| **原始 PDF** | 35 个（已分类） |
| **领域数** | 3 |
| **最后更新** | 2026-06-01 |

---

## 使用方式

### 手动查询

```bash
# 搜索关键词
grep -r "关键词" ~/.claude/knowledge/primary/

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
| [算法规格书模板](docs/templates/algorithm_spec_template.md) | 阶段1 |
| [MATLAB 黄金模型](docs/templates/golden_model_template/) | 阶段2 |
| [定点量化报告](docs/templates/fixed_point_report_template.md) | 阶段3 |
| [资源评估报告](docs/templates/resource_estimate_template.md) | 阶段4 |
| [RTL 模块模板](docs/templates/rtl_module_template.v) | 阶段5 |
| [Testbench 模板](docs/templates/tb_template.sv) | 阶段6 |
| [技术报告模板](docs/templates/report_template.md) | 阶段7 |
