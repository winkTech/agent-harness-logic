---
name: knowledge-index
description: 知识库主索引 — 导航到所有 primary 文档、鸢尾花书蒸馏、引用文档和模板
metadata:
  type: reference
  domain: meta
tags: [index, navigation, knowledge-base]
---

# 知识库索引

> 导航: [场景入口卡](SCENE_CARDS.md) — [标签索引](TAG_INDEX.md) — [知识库规则](KNOWLEDGE_RULES.md)
> 最后更新: 2026-07-18 | 文档: 97 篇 primary + 37 篇 source + 40 篇 鸢尾花书蒸馏 + 4 篇 methodology + 17 篇 references + 19 篇 templates

---

## 目录结构

```
knowledge/
├── INDEX.md              # 本文件（紧凑索引）
├── SCENE_CARDS.md        # 场景入口卡
├── TAG_INDEX.md          # 标签快速定位
├── KNOWLEDGE_RULES.md    # 知识库管理规则 ★
├── primary/              # 精炼知识文档（按域分类）
│   ├── domains/comm/     # 通信算法 51 篇
│   ├── domains/fpga/     # FPGA 设计 25 篇
│   ├── domains/python/   # Python 工具
│   ├── domains/matlab/   # MATLAB 模型
│   ├── cross-project-experience.md
│   └── knowledge-graph.md
├── references/           # 引用文档 + SVA/EDA 调试参考（17 篇）
│   ├── sva-patterns.md
│   └── eda-debug-checklist.md
├── docs/                 # 文档模板
│   └── templates/        # UVM/CI/PRD 等模板 + makefile-templates/
├── methodology/          # 算法方法论（NEW 2026-06-14）
│   ├── fixed-point-methodology.md
│   ├── test-vector-generation.md
│   ├── golden-model-standards.md
│   └── matlab-mcp-guide.md
├── archive/sources/fpga/ # 39 本书籍全文提取（~200K 行，按需搜索）
├── source/datasheets/    # 原始 PDF（35 个）
├── python-basics/        # 鸢尾花书蒸馏: Python 编程
├── math-foundation/      # 鸢尾花书蒸馏: 微积分/优化
├── linear-algebra/       # 鸢尾花书蒸馏: 线性代数
├── probability-statistics/ # 鸢尾花书蒸馏: 概率论
└── data-viz/             # 鸢尾花书蒸馏: 可视化
```

---

## 通信算法 (51)

**WiFi** — `wifi/overview`, `phy-layer`, `phy-implementation`, `mac-layer`, `ldpc-bcc-encoding` (NEW ✦)

**OFDM** — `ofdm/algorithm_spec`, `rtl_architecture`, `fixed_point_report`, `resource_estimate`, `report_ofdm_fpga_implementation`, `testbench_plan`, `golden_model/`, `uvm_tb/`

**RRC** — `rrc/algorithm_spec`, `fixed_point_report`, `resource_estimate`, `report_rrc_fpga_implementation`, `uvm_tb/`

**ChEst** — `channel_est/algorithm_spec`, `fixed_point_report`, `resource_estimate`, `report_channel_est_fpga_implementation`, `golden_model/`, `run_rtl_cosim.m`, `tb_chEst_cosim.sv`, `uvm_tb/`

**Sync** — `synch/algorithm_spec`, `fixed_point_report`, `resource_estimate`, `report_sync_fpga_implementation`, `uvm_tb/`

**LDPC** — `ldpc/algorithm_spec`, `encoding_spec`, `stage3_fixed_point_report`, `stage4_resource_estimation`, `stage7_fpga_implementation_report`, `uvm_tb/`

**5G NR** — `5g-nr/overview.md`, `nr-frame-structure`, `nr-ldpc`, `polar-code`, `pdsch`, `pusch`, `pdcch`, `nr-prach`, `mimo-detection`, `fr2-beam-management`, `nru`, `ntn`, `nr-test-mode`

**ORAN** — `5g-nr/oran-interface`, `oran-ric`, `oran-smo`, `lowphy-architecture`, `dfe-architecture`, `bfp-compression`

**LTE** — `lte/overview`, `phy-downlink`, `phy-uplink`

**卷积码** — `convolutional-coding/algorithm_spec` (NEW ✦ 全文覆盖 编码+译码+定点+向量)

**General** — `golden_model_lessons.md`, `data_structure.md`

---

## FPGA 设计 (25)

**Guides** — `fpga-design-guide`, `fpga-best-practices`, `fpga-development-workflow`, `learning-path`, `fpga-team-collaboration`

**Verilog/SV** — `verilog-design-experience`, `verilog-coding-style`, `fpga-coding-standards`, `ai-hardware-coding-spec`

**Timing** — `timing-constraints-guide`, `timing-convergence-cases`

**Tools** — `vivado-guide`, `vivado-automation-guide`

**High-Speed IO** — `jesd204b-guide`, `pcie-guide`, `aurora-guide`, `selectmap-guide`

**Platforms** — `rfsoc-guide`, `riscv-fpga-guide`

**Special Topics** — `algorithm-implementation`, `communication-algorithms`, `matlab-fpga-image-processing`

**UVM** — `uvm-verification-guide`

**Reference Projects** — `examples/async_fifo-master`, `axis_udp-main`, `basic_verilog-master`, `picorv32-main`, `r22sdf-master`, `verilog-pcie-master`

---

## Cross-Domain (4)

`cross-project-experience.md`, `knowledge-graph.md`, `pitfalls/avoid-global-reset.md`, `data_structure.md` (根目录)

> 工程脚本见 `engine/scripts/init-project.sh`, `engine/scripts/init-module.sh` (不在 knowledge/ 内)

---

## Source / PDF Archives

| Path | Contents |
|:-----|:---------|
| `primary/domains/fpga/sources-index.md` | 38 source docs index (name, size, notes) |
| `archive/sources/fpga/` | Full extracted text (~200K lines) |
| `source/datasheets/` | Original PDFs (35+) |

---

## Usage

```
1. 读 SCENE_CARDS.md → 匹配任务场景
2. 用 TAG_INDEX.md → 按标签缩小范围
3. 只加载目标文档（避免全文扫描）
4. 回退: grep -r "keyword" primary/
```

---

## 鸢尾花书蒸馏 (40 卡片, ~200KB)

来自 [PAPERS_DIR]/book 下 6 本书的精华提取。详见 [书籍去重映射](DEDUP-MAP.md)。

| 域 | 卡片数 | 原始大小 | 蒸馏后 | 压缩率 |
|---|-------|---------|-------|-------|
| [python-basics/](python-basics/) | 22 | 138M | 116K | 99.92% |
| [math-foundation/](math-foundation/) | 9 | 64M | 40K | 99.94% |
| [linear-algebra/](linear-algebra/) | 5 | 127M | 24K | 99.98% |
| [probability-statistics/](probability-statistics/) | 3 | 11M | 20K | 99.82% |
| [data-viz/](data-viz/) | 1 | 269M | 2.4K | 99.999% |
| **合计** | **40** | **~609M** | **~200KB** | **99.97%** |

### 快速跳转
- **Python 编程**: 语法/数据类型/控制流 → [索引](python-basics/) 或直接查 ch04-syntax, ch08-functions, ch13-numpy-basics
- **NumPy/Pandas**: 数值计算/数据处理 → ch13-numpy-basics, ch19-pandas-intro, ch21-22-pandas-indexing-reshape
- **机器学习**: sklearn 全流程 → ch28-sklearn-intro, ch30-33-sklearn-models
- **线性代数**: 向量/矩阵/EVD/SVD → [索引](linear-algebra/) 或查 04-evd-svd
- **微积分/优化**: 导数/积分/梯度下降 → [索引](math-foundation/) 或查 06-calculus
- **概率论**: 贝叶斯/分布/统计检验 → [索引](probability-statistics/)

## Stats (2026-07-03)

| Metric | Value |
|:-------|:-----:|
| Primary docs (不含 examples) | 97 |
| Primary docs (含 examples) | 128 |
| 鸢尾花书蒸馏 | 40 cards (~200KB) |
| Source extracts | 37 (~200K lines) |
| 引用文档 (references/) | 17 |
| 文档模板 (docs/templates/) | 19 |
| MATLAB models | 37 .m files |
| RTL modules | 19 .sv files |
| UVM testbenches | 5 algorithms |

> 计数自动更新: `node engine/scripts/kb-stats.cjs`
