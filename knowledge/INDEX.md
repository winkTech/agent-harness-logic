# 知识库索引

> 导航: [场景入口卡](SCENE_CARDS.md) — [标签索引](TAG_INDEX.md)
> 最后更新: 2026-06-05 | 文档: 76 篇 primary + 38 篇 source

---

## 目录结构

```
knowledge/
├── INDEX.md              # 本文件（紧凑索引）
├── SCENE_CARDS.md        # 场景入口卡 [NEW]
├── TAG_INDEX.md          # 标签快速定位 [NEW]
├── primary/              # 精炼知识文档（按域分类）
│   ├── domains/comm/     # 通信算法 47 篇
│   ├── domains/fpga/     # FPGA 设计 25 篇
│   ├── domains/python/   # Python 工具
│   ├── domains/matlab/   # MATLAB 模型
│   └── cross-project-experience.md
├── archive/sources/fpga/ # 38 本书籍全文提取（~200K 行，按需搜索）
└── source/datasheets/    # 原始 PDF（35+ 个）
```

---

## 通信算法 (47)

**OFDM** — `ofdm/algorithm_spec`, `rtl_architecture`, `fixed_point_report`, `resource_estimate`, `report_ofdm_fpga_implementation`, `testbench_plan`, `golden_model/`, `uvm_tb/`

**RRC** — `rrc/algorithm_spec`, `fixed_point_report`, `resource_estimate`, `report_rrc_fpga_implementation`, `uvm_tb/`

**ChEst** — `channel_est/algorithm_spec`, `fixed_point_report`, `resource_estimate`, `report_channel_est_fpga_implementation`, `golden_model/`, `run_rtl_cosim.m`, `tb_chEst_cosim.sv`, `uvm_tb/`

**Sync** — `synch/algorithm_spec`, `fixed_point_report`, `resource_estimate`, `report_sync_fpga_implementation`, `uvm_tb/`

**LDPC** — `ldpc/algorithm_spec`, `encoding_spec`, `stage3_fixed_point_report`, `stage4_resource_estimation`, `stage7_fpga_implementation_report`, `uvm_tb/`

**5G NR** — `5g-nr/overview.md`, `nr-frame-structure`, `nr-ldpc`, `polar-code`, `pdsch`, `pusch`, `pdcch`, `nr-prach`, `mimo-detection`, `fr2-beam-management`, `nru`, `ntn`, `nr-test-mode`

**ORAN** — `5g-nr/oran-interface`, `oran-ric`, `oran-smo`, `lowphy-architecture`, `dfe-architecture`, `bfp-compression`

**LTE** — `lte/overview`, `phy-downlink`, `phy-uplink`

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

## Cross-Domain (3)

`cross-project-experience.md`, `knowledge-graph.md`, `pitfalls/avoid-global-reset.md`

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

## Stats (2026-06-05)

| Metric | Value |
|:-------|:-----:|
| Primary docs | 76 (comm 47 + fpga 25 + cross 4) |
| Source extracts | 38 (~200K lines) |
| MATLAB models | 37 .m files |
| RTL modules | 19 .sv files |
| UVM testbenches | 5 algorithms |
