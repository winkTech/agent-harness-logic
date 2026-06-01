---
title: "FPGA 知识图谱"
domain: fpga
tags: [knowledge-graph, relationships, concepts]
created: 2026-06-01
updated: 2026-06-01
difficulty: advanced
---

# FPGA 知识图谱

## 概述

本文档建立 FPGA 领域的知识图谱，展示各概念之间的关系，帮助理解和记忆。

---

## 一、核心概念关系图

```
                        ┌─────────────┐
                        │   FPGA     │
                        │  (核心)    │
                        └──────┬──────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   硬件设计    │    │   工具链     │    │   应用领域    │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │                    │                    │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │         │          │         │          │         │
   ▼         ▼          ▼         ▼          ▼         ▼
Verilog  VHDL      Vivado  ModelSim   通信    图像处理
```

---

## 二、知识领域关系

### 1. Verilog/SV 知识体系

```
Verilog/SV
    │
    ├── 语法基础
    │   ├── 数据类型 (wire, reg, integer)
    │   ├── 运算符 (算术, 逻辑, 位运算)
    │   └── 控制结构 (always, assign, initial)
    │
    ├── 设计方法
    │   ├── 组合逻辑 (always @(*))
    │   ├── 时序逻辑 (always @(posedge clk))
    │   └── 状态机 (三段式)
    │
    └── 高级特性
        ├── Packed Array
        ├── 参数化设计
        └── 生成语句 (generate)
```

### 2. FPGA 开发流程

```
FPGA 开发流程
    │
    ├── 设计阶段
    │   ├── 需求分析
    │   ├── 架构设计
    │   └── 模块划分
    │
    ├── 编码阶段
    │   ├── HDL 编码
    │   ├── 代码审查
    │   └── 语法检查
    │
    ├── 验证阶段
    │   ├── 功能仿真
    │   ├── 时序仿真
    │   └── 代码覆盖
    │
    └── 实现阶段
        ├── 综合
        ├── 布局布线
        ├── 时序分析
        └── 比特流生成
```

### 3. 时序知识体系

```
时序设计
    │
    ├── 基础概念
    │   ├── 建立时间 (Setup Time)
    │   ├── 保持时间 (Hold Time)
    │   ├── 时钟偏移 (Skew)
    │   └── 时钟抖动 (Jitter)
    │
    ├── 约束类型
    │   ├── 时钟约束 (create_clock)
    │   ├── I/O 约束 (set_input_delay)
    │   ├── 虚假路径 (set_false_path)
    │   └── 多周期路径 (set_multicycle_path)
    │
    └── 优化方法
        ├── 插入流水线
        ├── 逻辑优化
        ├── 使用寄存器
        └── 调整布局布线
```

---

## 三、模块依赖关系

### 1. 通信系统模块

```
通信系统
    │
    ├── 发射端
    │   ├── 信道编码 (LDPC/Turbo)
    │   ├── 调制 (QAM/PSK)
    │   ├── OFDM (IFFT)
    │   └── 上变频 (DUC)
    │
    ├── 接收端
    │   ├── 下变频 (DDC)
    │   ├── OFDM (FFT)
    │   ├── 解调
    │   └── 信道译码
    │
    └── 同步
        ├── 载波同步
        ├── 符号同步
        └── 帧同步
```

### 2. 图像处理系统

```
图像处理系统
    │
    ├── 采集
    │   ├── 图像传感器接口
    │   ├── 数据缓存 (DDR)
    │   └── 格式转换
    │
    ├── 处理
    │   ├── 预处理 (滤波、增强)
    │   ├── 特征提取 (边缘、角点)
    │   └── 后处理 (二值化、形态学)
    │
    └── 显示
        ├── VGA 控制器
        ├── HDMI 控制器
        └── 帧缓存管理
```

---

## 四、算法关系图

### 1. 数字信号处理

```
DSP 算法
    │
    ├── 滤波
    │   ├── FIR 滤波器
    │   ├── IIR 滤波器
    │   └── 卡尔曼滤波
    │
    ├── 变换
    │   ├── FFT/IFFT
    │   ├── DCT
    │   └── 小波变换
    │
    └── 估计
        ├── 频率估计
        ├── 相位估计
        └── 信道估计
```

### 2. 加密算法

```
加密算法
    │
    ├── 对称加密
    │   ├── AES
    │   ├── DES
    │   └── SM4
    │
    ├── 非对称加密
    │   ├── RSA
    │   └── ECC
    │
    └── 哈希
        ├── SHA-256
        └── MD5
```

---

## 五、工具链关系

### Vivado 工具链

```
Vivado
    │
    ├── 设计输入
    │   ├── HDL 编辑器
    │   ├── IP Catalog
    │   └── Block Design
    │
    ├── 综合
    │   ├── Synthesis
    │   ├── Optimization
    │   └── Technology Mapping
    │
    ├── 实现
    │   ├── Place & Route
    │   ├── Timing Analysis
    │   └── Power Analysis
    │
    └── 调试
        ├── ILA
        ├── VIO
        └── Logic Analyzer
```

---

## 六、学习路径图

### 初学者路径

```
基础入门
    │
    ├── Week 1-2: FPGA 基础
    │   ├── 了解 FPGA 架构
    │   ├── 学习 Verilog 语法
    │   └── 编写简单模块
    │
    ├── Week 3-4: 编码进阶
    │   ├── 掌握编码规范
    │   ├── 学习时序设计
    │   └── 避免常见陷阱
    │
    └── Week 5-6: 工具掌握
        ├── 熟练使用 Vivado
        ├── 掌握开发流程
        └── 完成完整项目
```

### 进阶路径

```
进阶学习
    │
    ├── Month 2: 算法实现
    │   ├── FIR/IIR 滤波器
    │   ├── FFT/IFFT
    │   └── 数字下变频
    │
    ├── Month 3: 通信系统
    │   ├── OFDM 系统
    │   ├── MIMO 技术
    │   └── 信道编解码
    │
    └── Month 4: 高级主题
        ├── RFSoC 开发
        ├── RISC-V 嵌入式
        └── AI 加速器
```

---

## 七、常见问题关联

### 问题 → 解决方案映射

| 问题 | 相关概念 | 解决方案 |
|------|----------|----------|
| **时序违例** | 时序设计、流水线 | 插入流水线、优化逻辑 |
| **资源不足** | 资源优化、IP Core | 资源共享、使用 IP Core |
| **功耗过高** | 功耗设计、时钟门控 | 降低频率、使用时钟门控 |
| **仿真不收敛** | 时序设计、复位策略 | 检查时序、验证复位 |
| **综合失败** | 语法、编码规范 | 检查语法、遵循规范 |

---

## 八、最佳实践关联

### 实践 → 文档映射

| 最佳实践 | 相关文档 |
|----------|----------|
| **编码规范** | fpga-coding-standards.md, verilog-coding-style.md |
| **时序设计** | timing-constraints-guide.md |
| **资源优化** | fpga-best-practices.md |
| **团队协作** | fpga-team-collaboration.md |
| **工具使用** | vivado-guide.md, fpga-development-workflow.md |

---

## 九、参考资源

### 核心文档

| 文档 | 用途 |
|------|------|
| fpga-design-guide.md | 入门必读 |
| verilog-design-experience.md | Verilog 基础 |
| fpga-coding-standards.md | 编码规范 |
| timing-constraints-guide.md | 时序约束 |
| vivado-guide.md | 工具使用 |

### 进阶文档

| 文档 | 用途 |
|------|------|
| algorithm-implementation.md | 算法实现 |
| communication-algorithms.md | 通信算法 |
| rfsoc-guide.md | RFSoC 开发 |
| riscv-fpga-guide.md | RISC-V 嵌入式 |
