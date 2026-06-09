# 标签索引

> 快速按标签定位文档。每行格式：`doc-path | 场景标签` 或压缩行。
> 用法：识别用户意图 → 选目标 tag → 加载匹配文档

---

## 域 (domain)

| Tag | 文档 | 计数 |
|:----|:-----|:----:|
| `comm` | [WiFi](primary/domains/comm/wifi/), [信道估计](primary/domains/comm/channel_est/), [LDPC](primary/domains/comm/ldpc/), [OFDM](primary/domains/comm/ofdm/), [RRC](primary/domains/comm/rrc/), [同步](primary/domains/comm/synch/), [5G NR](primary/domains/comm/5g-nr/), [LTE](primary/domains/comm/lte/) 全部 | ~51 |
| `fpga` | [指南](primary/domains/fpga/) 全部（不含 examples） | ~25 |
| `python` | [硬件调试工具](primary/domains/python/README.md), skills/* | ~10 |
| `matlab` | [模型](primary/domains/matlab/README.md), golden models, cosim | ~40+ |

---

## 算法 (algo)

| Tag | 文档路径 | 说明 |
|:----|:---------|:-----|
| `ofdm` | comm/ofdm/algorithm_spec, rtl_architecture, fixed_point_report, resource_estimate, report_ofdm_fpga_implementation, testbench_plan | OFDM 全链路 |
| `rrc` | comm/rrc/algorithm_spec, fixed_point_report, resource_estimate, report_rrc_fpga_implementation | 成形滤波 |
| `channel-est` | comm/channel_est/algorithm_spec, fixed_point_report, resource_estimate, report_channel_est_fpga_implementation, golden_model/src/generate_vectors, run_rtl_cosim, tb_chEst_cosim | 信道估计 |
| `sync` | comm/synch/algorithm_spec, fixed_point_report, resource_estimate, report_sync_fpga_implementation | 同步 |
| `ldpc` | comm/ldpc/algorithm_spec, encoding_spec, stage3_fixed_point_report, stage4_resource_estimation, stage7_fpga_implementation_report | LDPC 编解码 |

---

## 标准 (standard)

| Tag | 文档路径 | 说明 |
|:----|:---------|:-----|
| `wifi` | comm/wifi/overview, phy-layer, phy-implementation, mac-layer, ldpc-bcc-encoding | 802.11 WiFi 知识集 (NEW ✦) |
| `lte` | comm/lte/overview, phy-downlink, phy-uplink | 4G LTE |
| `5g-nr` | comm/5g-nr/overview, nr-frame-structure, nr-ldpc, polar-code, pdsch, pusch, pdcch, nr-prach, nr-test-mode, fr2-beam-management, mimo-detection, nru, ntn | 5G NR |
| `802.11n` | comm/ldpc/algorithm_spec | WiFi LDPC |
| `oran` | comm/5g-nr/oran-interface, oran-ric, oran-smo, bfp-compression, lowphy-architecture, dfe-architecture | O-RAN 全平面 |

---

## 接口 (interface)

| Tag | 文档路径 | 说明 |
|:----|:---------|:-----|
| `jesd204b` | fpga/jesd204b-guide | JESD204B 串行接口 |
| `pcie` | fpga/pcie-guide | PCIe DMA/TLP |
| `aurora` | fpga/aurora-guide | Aurora 8B/10B 64B/66B |
| `selectmap` | fpga/selectmap-guide | SelectMap 并行配置 |
| `high-speed-io` | fpga/pcie-guide, aurora-guide, jesd204b-guide | 高速接口合集 |

---

## 工具 (tool)

| Tag | 文档路径 | 说明 |
|:----|:---------|:-----|
| `vivado` | fpga/vivado-guide, vivado-automation-guide, timing-constraints-guide, timing-convergence-cases | Vivado 全工具链 |
| `tcl` | fpga/vivado-automation-guide | Tcl 自动化 |
| `timing` | fpga/timing-constraints-guide, timing-convergence-cases | 时序约束与收敛 |
| `matlab` | fpga/matlab-fpga-image-processing; 各算法 golden model; run_rtl_cosim.m | MATLAB 建模 |
| `python` | skills/python-hardware-debug/templates/* | Python 硬件调试 |
| `modelsim` | 各算法 sim/ 目录 | ModelSim 仿真 |

---

## 文档类型 (type)

| Tag | 文档路径 | 说明 |
|:----|:---------|:-----|
| `spec` | comm/*/algorithm_spec,  comm/ldpc/encoding_spec | 算法规格书 |
| `fixed-point` | comm/*/fixed_point_report | 定点量化报告 |
| `resource` | comm/*/resource_estimate | 资源评估 |
| `rtl` | comm/*/rtl_architecture, 各算法 rtl/ 目录 | RTL 架构 |
| `impl` | comm/wifi/phy-implementation, comm/*/report_*_fpga_implementation | FPGA 实现报告 |
| `guide` | fpga/*-guide.md, fpga/fpga-design-guide | 设计指南 |
| `overview` | comm/5g-nr/overview, comm/lte/overview | 系统概述 |
| `tutorial` | fpga/learning-path, fpga/fpga-best-practices | 学习教程 |
| `uvm` | fpga/uvm-verification-guide, comm/*/uvm_tb/ | UVM 验证 |
| `cosim` | comm/channel_est/run_rtl_cosim.m | MATLAB→RTL 贯通 |
| `debug` | skills/python-hardware-debug/templates/*, fpga/timing-convergence-cases | 调试工具 |
| `reference` | fpga/sources-index.md, 各 examples/ 参考工程 | 参考资源 |

---

## 技能 (skill)

| Tag | 文档路径 | 说明 |
|:----|:---------|:-----|
| `hdl-coding` | skills/hdl-coding/ | RTL 编码 Skill |
| `tdd` | skills/tdd/ | TDD 工作流 |
| `rag` | skills/rag-skill/ | 知识库检索 |
| `python-debug` | skills/python-hardware-debug/ | Python 硬件调试 |
| `code-review` | skills/code-review/ | 代码审查 |

---

## 记忆系统 (memory)

| Tag | 文档路径 | 说明 |
|:----|:---------|:-----|
| `work` | var/work/* | 工作记忆（14天） |
| `error` | memory/errors/* | 错误经验（90天） |
| `learning` | memory/learnings/* | 学习总结（永久） |
| `project` | memory/projects/* | 项目规划 |
| `archive` | memory/archive/* | 已归档 |

---

## 组合查询模式

```
组合标签可快速缩小范围:
  tag:comm + tag:ldpc + tag:spec   → LDPC 算法规格书
  tag:fpga + tag:timing             → 时序约束与收敛
  tag:5g-nr + tag:overview          → NR 系统概述
  tag:fpga + tag:high-speed-io      → 全部高速接口指南
  tag:comm + tag:uvm                → 所有 UVM 验证文件
```

