# 知识库目录结构

> 最后更新: 2026-06-02

## 目录说明

本知识库用于存储 FPGA 开发、通信算法、Python、MATLAB 等领域的技术知识。

---

## 一级目录

| 目录 | 用途 | 文件数 |
|------|------|--------|
| `primary/` | 主要知识（Markdown） | 28 个 |
| `source/` | 原始文档（PDF） | 35 个 |

---

## primary/ 目录结构

### domains/ — 领域知识

#### fpga/ — FPGA 开发知识

**基础入门**:
- `fpga-design-guide.md` — FPGA 设计指南，涵盖基础概念、设计流程、编码规范
- `verilog-design-experience.md` — Verilog 设计经验总结，常见陷阱和最佳实践
- `fpga-best-practices.md` — FPGA 设计最佳实践，来自团队协作经验

**编码规范**:
- `fpga-coding-standards.md` — FPGA 代码规范，命名、格式、注释要求
- `verilog-coding-style.md` — Verilog/SystemVerilog 编码风格，代码优化技巧
- `ai-hardware-coding-spec.md` — AI-Hardware 协同设计规范，AI 生成代码规范

**时序约束**:
- `timing-constraints-guide.md` — 时序约束指南，时钟约束、I/O 约束、虚假路径

**工具使用**:
- `vivado-guide.md` — Vivado 使用指南，Tcl 脚本、调试工具、自动化
- `fpga-development-workflow.md` — FPGA 开发工作流，项目创建到比特流生成

**算法实现**:
- `algorithm-implementation.md` — FPGA 算法实现，以太网、LRU、CAM、哈希等
- `communication-algorithms.md` — 通信算法 FPGA 实现，MIMO-OFDM、LDPC、扩频
- `rfsoc-guide.md` — RFSoC 开发指南，ADC/DAC、DDC/DUC、DPD
- `riscv-fpga-guide.md` — RISC-V FPGA 嵌入式系统设计
- `matlab-fpga-image-processing.md` — MATLAB/FPGA 图像处理

**团队协作**:
- `fpga-team-collaboration.md` — FPGA 团队协作指南
- `fpga-development-workflow.md` — FPGA 开发工作流

#### comm/ — 通信算法知识包（新建）

| 算法 | 文档数 | 覆盖阶段 | 状态 |
|------|--------|----------|------|
| OFDM | 4 | 阶段1/4/5/6 | 进行中 |
| 成形滤波 | 0 | - | 未开始 |
| 信道估计 | 0 | - | 未开始 |
| 同步 | 0 | - | 未开始 |
| LDPC | 0 | - | 未开始 |

**模板位置**: `docs/templates/`（通用7阶段模板）
