---
name: knowledge-archive-index
title: Archive
type: reference
tags: [knowledge-base, archive, index]
updated: 2026-07-03
---

# Archive

> 最后更新: 2026-06-19

## 目录说明

`archive/` 存放已从 `primary/` 域移出的**源文档原文**。这些文档主要是大型书籍的全文提取，合计 38 个文件（约 201,163 行）。移出 `primary/` 域以保持主知识库的索引与搜索效率，需要全文时可通过本目录定位。

## 子目录结构

```
archive/
├── README.md                 ← 本文件
└── sources/
    └── fpga/                 ← FPGA 源文档（含 38 个 .md 文件）
```

目前仅含 `sources/fpga/` 一个子目录，后续归档其他域时会扩展。

## 文件清单

### sources/fpga/ (38 个源文档)

#### 大型图书提取 (>10,000 行)

| # | 文件名 | 行数 | 说明 |
|:-:|:-------|:----:|:-----|
| 1 | `Xilinx FPGA数字信号处理系统设计指南_14545425 (1)-source.md` | 43,626 | Xilinx 官方 DSP 设计指南，含 FIR/FFT/CORDIC 等 IP 核使用 |
| 2 | `RFSoC_SDR_book Software Defined Radio with Zynq UltraScale+ RFSoC-source.md` | 28,914 | Zynq UltraScale+ RFSoC 软件无线电设计 |
| 3 | `软件无线电原理与应用 [楼才义，徐建良，杨小牛 编著] 2014年版-source.md` | 23,143 | SDR 基础理论与工程实践 |
| 4 | `锁相环技术第3版-source.md` | 16,470 | PLL 设计理论、数字锁相环实现 |
| 5 | `AMD FPGA设计优化宝典：面向Vivado System Verilog_2023-source.md` | 15,681 | Vivado/SV 设计优化、时序收敛技巧 |
| 6 | `扩频通信数字基带信号处理算法及其VLSI实现-source.md` | 10,755 | 扩频通信基带算法与 VLSI 实现 |

#### 中型提取 (1,000-10,000 行)

| # | 文件名 | 行数 | 说明 |
|:-:|:-------|:----:|:-----|
| 7 | `MIMO-OFDM技术原理-source.md` | 9,574 | MIMO-OFDM 系统原理与设计 |
| 8 | `基于matlab与fpga的图像处理教程-source.md` | 9,180 | 软硬件协同图像处理教程 |
| 9 | `timing-constraints-source.md` | 8,545 | 时序约束完整指南（含 SDC 命令详解） |
| 10 | `vivado-tcl-source.md` | 4,728 | Tcl 脚本与 Vivado 自动化 |
| 11 | `Vivado+Tcl零基础入门与案例实战+(高亚军)+-source.md` | 4,728 | Vivado Tcl 实战（高亚军著） |
| 12 | `Vivado从此开始（进阶篇）_高亚军+(作者)+_2020年1月第1版_k-source.md` | 4,629 | Vivado 高级用法（高亚军著） |
| 13 | `5G通信系统中LDPC编译码器的设计与实现_白薇(1)-source.md` | 4,565 | 5G NR LDPC 编码器 FPGA 实现（硕士论文） |
| 14 | `FPGA设计——基于团队的最佳实践.pdf (美）辛普森 （Simpson， P. ）著；何春泽) -source.md` | 4,495 | 团队级 FPGA 开发方法论 |

#### 小型提取 (<1,000 行)

| # | 文件名 | 行数 | 说明 |
|:-:|:-------|:----:|:-----|
| 15 | `玩转FPGA-source.md` | 1,394 | FPGA 设计经验谈 |
| 16 | `play-fpga-source.md` | 1,394 | 同上（英文版，内容重复） |
| 17 | `代码应该这样写-source.md` | 751 | Verilog 编码技巧（系列首篇） |
| 18 | `代码应该这样写（2）-source.md` | 673 | Verilog 编码技巧系列 2 |
| 19 | `代码应该这样写（3）-source.md` | 667 | Verilog 编码技巧系列 3 |
| 20 | `代码应该这样写（4）-source.md` | 667 | Verilog 编码技巧系列 4 |
| 21 | `代码应该这样写（5）-source.md` | 682 | Verilog 编码技巧系列 5 |
| 22 | `代码应该这样写（6）-source.md` | 655 | Verilog 编码技巧系列 6 |
| 23 | `代码应该这样写（7）-source.md` | 639 | Verilog 编码技巧系列 7 |
| 24 | `代码应该这样写（8）-source.md` | 642 | Verilog 编码技巧系列 8 |
| 25 | `代码应该这样写（9）-source.md` | 642 | Verilog 编码技巧系列 9 |
| 26 | `代码应该这样写（10）-source.md` | 643 | Verilog 编码技巧系列 10 |
| 27 | `在FPGA上部署5G NR无线通信：一套完整的MATLAB与Simulink工作流程-source.md` | 599 | Xilinx 白皮书：MATLAB+Simulink+FPGA NR 原型 |
| 28 | `cn-fpga-whitepaper-source.md` | 599 | 同上（中文版，内容重复） |
| 29 | `fpga-coding-standards-source.md` | 620 | 代码规范参考（已提炼） |
| 30 | `算术逻辑部件设计_蒋小龙-source.md` | 615 | ALU 设计 |
| 31 | `systemverilog-packed-array-source.md` | 209 | packed array 使用技巧 |
| 32 | `SystemVerilog_ 用好packed array-source.md` | 209 | 同上（重复文件） |
| 33 | `总结的一些verilog设计经验-source.md` | 173 | Verilog 编码原则 |
| 34 | `在FPGA开发中尽量避免全局复位的使用-source.md` | 170 | Xilinx 推荐实践 |
| 35 | `avoid-global-reset-source.md` | 170 | 同上（原在 pitfalls/ 目录） |
| 36 | `verilog-hdl-algorithm-source.md` | 92 | Verilog HDL 网络案例 |
| 37 | `Verilog HDL算法与电路设计 通信和计算机网络典型案例-source.md` | 92 | 同上（重复文件） |

#### 空占位文件

| # | 文件名 | 说明 |
|:-:|:-------|:------|
| 38 | `无线通信的MATLAB和FPGA实现-source.md` | 空占位，未提取到内容（但在 `communication-algorithms.md` 中被引用为源） |
| 39 | `基于FPGA与RISC-V的嵌入式系统设计 (顾长怡编著)-source.md` | 空占位，未提取到内容（但在 `riscv-fpga-guide.md` 中被引用为源） |

## 导航

- **源文档索引（含反向映射）**: `knowledge/primary/domains/fpga/sources-index.md`
- **FPGA 主域**: `knowledge/primary/domains/fpga/`
- **搜索入口**: 使用 `rag-skill` 或 `code-search` 在全文中搜索
