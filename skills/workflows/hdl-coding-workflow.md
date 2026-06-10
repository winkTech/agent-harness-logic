---
name: hdl-coding-workflow
description: RTL 开发全流程 — 算法分析→架构设计→定点量化→TB向量生成→逐模块RTL+MATLAB验证→顶层全链仿真→回归→审查→报告
version: 3.4.0
agents: [developer, qa, code-reviewer]
phases: 9
triggers:
  - new algorithm module
  - new RTL module
  - testbench creation
  - resource evaluation
  - code review prep
---

# HDL Coding Workflow (v3.4)

## 核心原则
- **自顶向下**: 先架构框图，再模块方案，再代码
- **Golden Model 绝对权威**: 定点和 RTL 都围绕 Golden Model 展开
- **RTL ↔ MATLAB 严格对标**: RTL 每模块必须与 MATLAB 模型的步骤一一对应
- **逐模块验证 [MUST]**: 每模块写完后必须先仿真验证与 MATLAB 输出一致，通过后才继续下一模块
- **全链联调 [MUST]**: 所有子模块通过后，搭建顶层，全链逐级与 golden model 对比，全 pass 才算过
- **验证左移**: 每层有检查点，仿真日志实时可读
- **不可跳越**: Phase N 产出是 Phase N+1 输入
- **3-迭代复盘规则**: 同一问题迭代 ≥ 3 次时，执行 `workflows/debug-retrospective.md`
- **LUT/映射模块门禁**: Phase 2 做逐点映射验证，Phase 4 做映射预验证三件套

---

## Phase 列表

| Phase | 目标 | 检查点 |
|:------|:-----|:--------|
| **0** 基础设施 | 统一 EDA 工具接口 (make lint/compile/sim/regress) + 文件清单 | Makefile + `.f` 创建，`make lint`/`compile` 通过 |
| **1** 架构设计 | 算法文档化 + 顶层框图 (模块↔MATLAB 对标) + 每模块方案 + 对称对分析 + architecture.yaml | algorithm_spec + architecture.yaml (含 pair_conventions) + 框图 + golden model 通过 |
| **2** 定点量化 | 位宽扫描 + bit-true 定点模型 + DSP/LUT/BRAM 预算表 | fixed_point_report + resource_estimate 在预算内 |
| **3** TB+向量生成 | 自检 Testbench + SVA 断言 + MATLAB golden 测试向量生成 | TB 编译通过，自检逻辑完整，测试向量已生成 |
| **4** 逐模块RTL+MATLAB验证 | **[MUST]** 每模块: 写RTL → 仿真 → 对比MATLAB → 通过 → 下一模块. [效率] 配对模块自动复用已完成端框架 | 验证矩阵全 ✅，每模块 bit-true 报告 |
| **5** 顶层集成+全链仿真 | **[MUST]** 所有子模块验证通过后，搭建顶层，全链逐级对比MATLAB golden | 全链各中间级与 golden model 一致，无 FAIL |
| **6** 回归覆盖率 | 全量回归 + mandatory 覆盖点 100% (必须真跑编译/仿真) | `make regress` 全绿，covergroup 全部触发 |
| **7** 代码审查 | 自审查清单 + 提交 code-review 质量审查 + 模型一致性检查 | 审查通过，仿真日志 + 覆盖率报告完备 |
| **8** 报告输出 | 汇总实现报告 + 文档归档 + 经验记录 | 报告完成，文档归档，经验已记录 |

---

## 关联资源

| 资源 | 路径 | 用途 |
|------|------|------|
| HDL 编码规范 | `skills/hdl-coding/SKILL.md` | 命名规则、时序安全、lint 门禁 |
| 算法→Verilog 参考 | `skills/hdl-coding/references/alg-flow-verilog.md` | 代码模板、NMSE 判定、排查表 |
| TDD 工作流 | `skills/tdd/SKILL.md` | Testbench-First 方法论 |
| Code Review 工作流 | `workflows/code-review-workflow.md` | Phase 7 审查环节 |
| Debug 复盘工作流 | `workflows/debug-retrospective.md` | Phase 4 迭代 ≥ 3 次时触发 |
| MATLAB MCP | CLAUDE.md | Golden model 生成与验证 |
| Project Spec Schema | `schemas/hdl-project-spec.schema.json` | Phase 1→3 数据契约 |
| Layer Status Schema | `schemas/hdl-layer-status.schema.json` | Phase 4→5 数据契约 |
| Developer / QA / Reviewer | `agents/core/developer.md` etc. | HDL 编码执行者 |
