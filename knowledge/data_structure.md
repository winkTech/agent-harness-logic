# 知识库目录结构

> 最后更新: 2026-06-01

## 目录说明

本知识库用于存储 FPGA 开发、Python、MATLAB 等领域的技术知识。

---

## 一级目录

| 目录 | 用途 | 文件数 |
|------|------|--------|
| `primary/` | 主要知识（Markdown） | 23 个 |
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
- `fpga-team-collaboration.md` — FPGA 团队协作指南，版本控制、代码审查

**学习路径**:
- `learning-path.md` — FPGA 学习路径，从基础到进阶

#### python/ — Python 编程知识

- `README.md` — Python 知识目录说明

#### matlab/ — MATLAB 使用知识

- `README.md` — MATLAB 知识目录说明

### pitfalls/ — 常见陷阱

- `avoid-global-reset.md` — 避免全局复位的使用

### patterns/ — 设计模式

（待填充）

### snippets/ — 代码片段

（待填充）

### references/ — 参考资料

（待填充）

---

## source/ 目录结构

### datasheets/ — 数据手册

#### fpga-design/ — FPGA 设计（8 个 PDF）

- `AMD FPGA设计优化宝典.pdf` — Vivado/SystemVerilog 设计优化
- `FPGA设计——基于团队的最佳实践.pdf` — 团队协作最佳实践
- `玩转FPGA.pdf` — FPGA 入门指南
- `在FPGA开发中尽量避免全局复位的使用.pdf` — 复位策略
- `cn-fpga-whitepaper.pdf` — FPGA 白皮书
- `基于FPGA与RISC-V的嵌入式系统设计.pdf` — RISC-V 嵌入式
- `算术逻辑部件设计_蒋小龙.pdf` — 算术逻辑设计
- `总结的一些verilog设计经验.pdf` — Verilog 经验总结

#### verilog-sv/ — Verilog/SV（12 个 PDF）

- `SystemVerilog_用好packed array.pdf` — Packed Array 使用
- `Verilog HDL算法与电路设计.pdf` — 算法与电路设计
- `代码应该这样写.pdf` — 编码风格优化（系列 1-10）

#### vivado/ — Vivado（2 个 PDF）

- `Vivado+Tcl零基础入门与案例实战.pdf` — Tcl 脚本
- `Vivado从此开始（进阶篇）.pdf` — Vivado 进阶

#### communications/ — 通信（10 个 PDF）

- `MIMO-OFDM技术原理.pdf` — MIMO-OFDM 技术
- `5G通信系统中LDPC编译码器的设计与实现.pdf` — LDPC 编译码
- `RFSoC_SDR_book.pdf` — RFSoC 软件无线电
- `无线通信的MATLAB和FPGA实现.pdf` — 通信实现
- `扩频通信数字基带信号处理算法及其VLSI实现.pdf` — 扩频通信
- `锁相环技术第3版.pdf` — 锁相环技术
- `在FPGA上部署5G NR无线通信.pdf` — 5G NR 部署
- `基于matlab与fpga的图像处理教程.pdf` — 图像处理
- `软件无线电原理与应用.pdf` — 软件无线电
- `Xilinx FPGA数字信号处理系统设计指南.pdf` — DSP 设计

#### coding-standards/ — 代码规范（3 个 PDF）

- `FPGA代码规范.pdf` — AI-Hardware 协同设计规范
- `FPGA时序约束与分析.pdf` — 时序约束与分析
- `GigE-Vision-Specification.pdf` — GigE Vision 协议

---

## 检索策略

### 关键词索引

| 关键词 | 相关文档 |
|--------|----------|
| **Verilog** | verilog-design-experience.md, verilog-coding-style.md, fpga-coding-standards.md |
| **时序** | timing-constraints-guide.md, fpga-design-guide.md |
| **Vivado** | vivado-guide.md, fpga-development-workflow.md |
| **状态机** | fpga-design-guide.md, ai-hardware-coding-spec.md |
| **复位** | avoid-global-reset.md, fpga-design-guide.md |
| **FIFO** | algorithm-implementation.md |
| **通信** | communication-algorithms.md, rfsoc-guide.md |
| **RISC-V** | riscv-fpga-guide.md |
| **图像处理** | matlab-fpga-image-processing.md |
| **RFSoC** | rfsoc-guide.md |
| **LDPC** | communication-algorithms.md |
| **MIMO** | communication-algorithms.md |
| **流水线** | fpga-design-guide.md, fpga-best-practices.md |
| **状态机** | fpga-design-guide.md, ai-hardware-coding-spec.md |
| **编码规范** | fpga-coding-standards.md, verilog-coding-style.md |
| **团队协作** | fpga-team-collaboration.md |
| **学习路径** | learning-path.md |

---

## 使用说明

### 手动检索

```bash
# 搜索关键词
grep -r "关键词" ~/.claude/knowledge/primary/

# 按标签搜索
grep -r "tags:.*标签" ~/.claude/knowledge/primary/

# 按领域搜索
ls ~/.claude/knowledge/primary/domains/fpga/
```

### AI 检索

1. 识别问题领域
2. 加载相关 Markdown 文档
3. 注入到上下文
