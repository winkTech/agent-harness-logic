---
name: resource-estimate-template
title: "Resource Estimate Template"
description: "Resource estimation template for FPGA design covering DSP48 mapping, architecture scaling, resource budgeting, and alternative mapping strategies"
algorithm: "<算法名称>"
target_device: "<器件型号>"
version: "1.0"
created: "<日期>"
---

# <算法名称> 资源评估报告

## 1. DSP48 映射分析

### 1.1 乘加运算映射表

| 运算 | 位宽(A×B) | DSP48 数量 | 映射方式 | 说明 |
|------|-----------|-----------|----------|------|
| | | | 级联/拆分 | |

### 1.2 总 DSP48 消耗

| 模块 | 复数乘 | 实数乘 | 加法 | DSP48合计 |
|------|--------|--------|------|----------|
| | | | | |

## 2. 架构缩放方案对比

### 2.1 三种方案

| 方案 | 并行度 | DSP48 | LUT | BRAM | 吞吐(clk/data) | 延迟 |
|------|--------|-------|-----|------|----------------|------|
| A: 全并行 | ×N | | | | 1 | |
| B: 半并行 | ×N/2 | | | | 2 | |
| C: 全串行 | ×1 | | | | N | |

### 2.2 推荐方案

**理由:**

## 3. 资源预算

### 3.1 目标器件规格

| 资源 | 可用量 | 预估消耗 | 占比 | 裕量 |
|------|--------|----------|------|------|
| DSP48 | | | % | % |
| LUT | | | % | % |
| FF | | | % | % |
| BRAM | | | % | % |

### 3.2 瓶颈分析

_消耗最大的模块及优化建议_

## 4. 替代映射方案

### 4.1 DSP48 vs LUT 替换边界

| 条件 | 建议 |
|------|------|
| 位宽 ≤ 12bit | LUT 实现更省 |
| 系数固定 | 用分布式 LUT |
| 使用率 < 20% | 优先 DSP48 |

### 4.2 推荐配置

_结论性建议_
