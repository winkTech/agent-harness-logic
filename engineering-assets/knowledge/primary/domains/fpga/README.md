---
name: fpga
---

# FPGA 开发知识

> Verilog/SystemVerilog、Vivado 工具链、时序收敛、高速接口、验证

---

## 文档列表

### 编码与规范

| 文档 | 内容 |
|------|------|
| [verilog-coding-style.md](verilog-coding-style.md) | Verilog 编码风格 |
| [verilog-design-experience.md](verilog-design-experience.md) | 设计经验汇总 |
| [fpga-coding-standards.md](fpga-coding-standards.md) | 编码标准 |
| [ai-hardware-coding-spec.md](ai-hardware-coding-spec.md) | AI 辅助硬件编码规范 |
| [algorithm-implementation.md](algorithm-implementation.md) | 算法到 RTL 的实现方法 |
| [communication-algorithms.md](communication-algorithms.md) | 通信算法硬件实现 |

### 工具链与流程

| 文档 | 内容 |
|------|------|
| [vivado-guide.md](vivado-guide.md) | Vivado 使用指南 |
| [vivado-automation-guide.md](vivado-automation-guide.md) | Vivado TCL 自动化 |
| [ipi-automation-guide.md](ipi-automation-guide.md) | IP Integrator 自动化 |
| [fpga-development-workflow.md](fpga-development-workflow.md) | 开发流程 |
| [fpga-design-guide.md](fpga-design-guide.md) | 设计指南 |
| [fpga-best-practices.md](fpga-best-practices.md) | 最佳实践 |
| [fpga-team-collaboration.md](fpga-team-collaboration.md) | 团队协作 |
| [learning-path.md](learning-path.md) | 学习路径 |

### 时序

| 文档 | 内容 |
|------|------|
| [timing-constraints-guide.md](timing-constraints-guide.md) | 时序约束 |
| [timing-convergence-cases.md](timing-convergence-cases.md) | 时序收敛案例 |

### 接口与 IP

| 文档 | 内容 |
|------|------|
| [ddr-mig-guide.md](ddr-mig-guide.md) | DDR / MIG |
| [pcie-guide.md](pcie-guide.md) | PCIe |
| [aurora-guide.md](aurora-guide.md) | Aurora 高速串行 |
| [jesd204b-guide.md](jesd204b-guide.md) | JESD204B |
| [selectmap-guide.md](selectmap-guide.md) | SelectMAP 配置 |
| [rfsoc-guide.md](rfsoc-guide.md) | RFSoC |
| [riscv-fpga-guide.md](riscv-fpga-guide.md) | RISC-V on FPGA |
| [ddr_axi4_controller.sv](ddr_axi4_controller.sv) | DDR AXI4 控制器参考 RTL |

### 验证与联合仿真

| 文档 | 内容 |
|------|------|
| [uvm-verification-guide.md](uvm-verification-guide.md) | UVM 验证平台 |
| [matlab-fpga-image-processing.md](matlab-fpga-image-processing.md) | MATLAB↔FPGA 图像处理 |

### 溯源

| 文档 | 内容 |
|------|------|
| [sources-index.md](sources-index.md) | 原始资料转写稿索引（`archive/sources/fpga/`） |

---

## 学习路径

```
Verilog 编码规范 → 时序约束 → Vivado 工具链 → 接口/IP → 验证 → 时序收敛调优
```

详见 [learning-path.md](learning-path.md)。

---

## 相关资源

- [AMD/Xilinx 官方文档](https://docs.amd.com/)
- 编码规则与模板：`skills/hdl-coding/SKILL.md`（含 UG901/UG949 参考与 Vivado 工具流）
- [常见陷阱](../../pitfalls/)
- 原始资料转写稿：`engineering-assets/knowledge/archive/sources/fpga/`
