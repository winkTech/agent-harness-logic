---
name: data-structure
title: "通信算法知识库"
tags: [comm]
description: "├── data_structure.md                # 本文件"
related: [5g-nr/bfp-compression.md, 5g-nr/dfe-architecture.md, 5g-nr/fr2-beam-management.md, 5g-nr/lowphy-architecture.md, 5g-nr/mimo-detection.md, 5g-nr/nr-frame-structure.md]
---
# 通信算法知识库

> 最后更新: 2026-06-02

## 目录结构

```
comm/
├── data_structure.md                # 本文件
├── lte/                             # 4G LTE 知识库 (Phase 1)
│   ├── overview.md                  # 系统架构/帧结构/信道分类
│   ├── phy-downlink.md              # 下行物理层 (OFDMA/PDCCH/PDSCH)
│   └── phy-uplink.md                # 上行物理层 (SC-FDMA/PRACH/PUSCH)
├── 5g-nr/                           # 5G NR 知识库 (Phase 1)
│   ├── oran-interface.md            # ORAN C/U/S/M-plane 协议
│   ├── lowphy-architecture.md       # Lowphy 链路 (FFT/相位补偿/交换)
│   ├── dfe-architecture.md          # DFE (CFR/DPD/DDC/DUC)
│   ├── bfp-compression.md           # BFP 6bit 块浮点压缩解压
│   └── nr-test-mode.md              # NR 测试模式与 EVM 测试
└── ofdm/                            # OFDM 知识包 (7阶段全部完成)
    ├── algorithm_spec.md            # 阶段1
    ├── fixed_point_report.md        # 阶段3
    ├── resource_estimate.md         # 阶段4
    ├── report_ofdm_fpga_implementation.md  # 阶段7
    ├── golden_model/           # 阶段2 (MATLAB 模型)
    │   ├── config.m
    │   ├── run_ofdm_sim.m
    │   ├── run_all_tests.m
    │   ├── src/     (8个文件)
    │   └── tests/   (3个文件)
    └── rtl/                    # 阶段5+6 (RTL + Testbench)
        ├── src/       (4个SV模块)
        ├── tb_tx_top.sv
        ├── run_sim.do
        └── constraints/
```

## 算法实现状态 (按阶段)

| 算法 | 阶段1 | 阶段2 | 阶段3 | 阶段4 | 阶段5 | 阶段6 | 阶段7 | 总计文件 |
|------|:----:|:----:|:----:|:----:|:----:|:----:|:----:|:------:|
| **OFDM** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **21** |
| 成形滤波 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 16 |
| 信道估计 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **19** |
| 同步 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **25** |
| LDPC | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 0 |

## 通用模板

`docs/templates/` (7阶段各1套)

## 框架文档

已融入 `skills/workflows/hdl-coding-workflow.md` v3（Phase 1: 算法分析/架构设计, Phase 2: 定点量化/资源评估）
