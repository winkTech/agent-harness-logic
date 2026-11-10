---
name: testbench-plan
title: "OFDM 发射机 验证方案"
tags: [comm, ofdm, testbench]
description: "MATLAB 测试向量 ──→ [txt/bin] ──→ [TB 读取] ──→ [DUT]"
related: [ofdm/algorithm_spec.md, ofdm/fixed_point_report.md, ofdm/report_ofdm_fpga_implementation.md, ofdm/resource_estimate.md, ofdm/rtl_architecture.md]
---
# OFDM 发射机 验证方案

## 1. Testbench 架构

```
MATLAB 测试向量 ──→ [txt/bin] ──→ [TB 读取] ──→ [DUT]
                                              │
            PASS/FAIL ←── [自动比对] ←── [DUT输出]
                              │
                        MATLAB 黄金输出
```

## 2. 测试用例

| 用例 | 调制 | 数据模式 | 检查项 |
|------|------|----------|--------|
| TC1_BPSK | BPSK | PRBS | 逐比特I/Q比对 |
| TC2_QPSK | QPSK | PRBS | 逐比特I/Q比对 |
| TC3_16QAM | 16QAM | PRBS | 逐比特I/Q比对 |
| TC4_64QAM | 64QAM | PRBS | 逐比特I/Q比对 |
| TC5_ALL_ZERO | BPSK | 全0 | 检查非零输出(IFFT特性) |
| TC6_TOGGLE | BPSK | 0101... | 边界 |
| TC7_PILOT_ONLY | - | 仅导频 | 导频位置正确性 |
| TC8_CONTINUOUS | QPSK | 连续符号 | 符号间连续性 |

## 3. 自动比对方法

```
tolerance = 1 LSB (bit-true)
max_error = max(abs(dut_out - golden))
if max_error <= 1:
    PASS
else:
    FAIL (max_error, error_location)
```

## 4. 覆盖率目标

| 类型 | 目标 | 方法 |
|------|------|------|
| line | 90%+ | ModelSim coverage |
| toggle | 85%+ | ModelSim coverage |
| 功能 | 100%用例 | 自定义covergroup |
