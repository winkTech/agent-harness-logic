---
name: project-directory-cleanup-discipline
description: "项目目录必须按 cross-project-experience.md 标准建，仿真 transient 文件必须清理"
metadata:
  type: feedback
---

# 项目目录 + 清理纪律 (2026-06-14)

卷积码项目中暴露了两个实操缺陷：

## 缺陷 1：目录不按标准建

`cross-project-experience.md` 已经定义了完整的 FPGA 项目目录结构（01_src/00_hdl、02_sim/、06_doc/、07_mat/、08_py/ 等），但 hdl-coding-workflow 的 Phase 0 从未引用它。结果卷积码项目用了自己的一套（01_src/、02_tb/、tv/ 散落在根目录）。

**修复**：Phase 0 prompt 改为直接引用跨项目标准建目录，增加了目录合规检查点。

**Why**：跨项目标准是多次迭代沉淀下来的最佳实践（文件分类、模块对应关系、工程管理），每个项目自创一套会导致混乱。

## 缺陷 2：仿真垃圾不清理

ModelSim 产生的 `work/`、`transcript`、`*.wlf`、`*.vcd` 等 transient 文件在项目目录中堆积。Phase 8 没有清理步骤。

**修复**：
- Makefile clean 目标必须删除所有 transient 文件
- Phase 8 prompt 增加清理指令
- .gitignore 必须排除 transient 文件

**How to apply**：每次执行 workflow，Phase 0 严格按标准建目录，Phase 8 最后 `make clean`。中途迭代如需清理，手动运行 `make clean`。

## 关联

[[cross-project-experience-ref]] — 跨项目标准目录
[[file-organization-discipline]] — 文件分类纪律
