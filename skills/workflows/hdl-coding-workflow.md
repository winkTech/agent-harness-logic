---
name: hdl-coding-workflow
description: RTL 开发全流程 — 算法分析→架构设计→定点量化→Testbench-First→增量仿真→透明调试
version: 3.1.0
agents: [developer, qa, code-reviewer]
phases: 8
triggers:
  - new algorithm module
  - new RTL module
  - testbench creation
  - resource evaluation
  - code review prep
---

# HDL Coding Workflow (v3)

## 核心原则
- **自顶向下**: 先架构框图，再模块方案，再代码
- **Golden Model 绝对权威**: 定点和 RTL 都围绕 Golden Model 展开
- **RTL ↔ MATLAB 严格对标**: RTL 每模块必须与 MATLAB 模型的步骤一一对应
- **验证左移**: 每层有检查点，仿真日志实时可读
- **不可跳越**: Phase N 产出是 Phase N+1 输入
- **3-迭代复盘规则**: 同一问题迭代 ≥ 3 次时，执行 `workflows/debug-retrospective.md`
- **LUT/映射模块门禁**: Phase 2 做逐点映射验证，Phase 4 做映射预验证三件套

---

## Phase 列表

| Phase | 目标 | 检查点 |
|:------|:-----|:--------|
| **0** 基础设施 | 统一 EDA 工具接口 (make lint/compile/sim/regress) + 文件清单 | Makefile + `.f` 创建，`make lint`/`compile` 通过 |
| **1** 架构设计 | 算法文档化 + 顶层框图 (模块↔MATLAB 对标) + 每模块方案 | algorithm_spec + 框图 + golden model 通过 |
| **2** 定点量化 | 位宽扫描 + bit-true 定点模型 + DSP/LUT/BRAM 预算表 | fixed_point_report + resource_estimate 在预算内 |
| **3** TB-First | 自检 Testbench + SVA 断言 + 结构化日志 | TB 编译通过，自检逻辑完整，SVA 无编译错误 |
| **4** 增量 RTL | 分层验证 + Stub 机制 + 双通道日志 + Bash 轮询 | Layer 0-4 依次通过，日志无 FAIL |
| **5** 回归覆盖率 | 全量回归 + mandatory 覆盖点 100% | `make regress` 全绿，covergroup 全部触发 |
| **6** 代码审查 | 自审查清单 + 提交 code-review 质量审查 | 审查通过，仿真日志 + 覆盖率报告完备 |
| **7** 报告输出 | 汇总实现报告 + 文档归档 + 经验记录 | 报告完成，文档归档，经验已记录 |

---

## 关联资源

| 资源 | 路径 | 用途 |
|------|------|------|
| HDL 编码规范 | `skills/hdl-coding/SKILL.md` | 命名规则、时序安全、lint 门禁 |
| 算法→Verilog 参考 | `skills/hdl-coding/references/alg-flow-verilog.md` | 代码模板、NMSE 判定、排查表 |
| TDD 工作流 | `skills/tdd/SKILL.md` | Testbench-First 方法论 |
| Code Review 工作流 | `workflows/code-review-workflow.md` | Phase 6 审查环节 |
| Debug 复盘工作流 | `workflows/debug-retrospective.md` | Phase 4 迭代 ≥ 3 次时触发 |
| MATLAB MCP | CLAUDE.md | Golden model 生成与验证 |
| Project Spec Schema | `schemas/hdl-project-spec.schema.json` | Phase 1→3 数据契约 |
| Layer Status Schema | `schemas/hdl-layer-status.schema.json` | Phase 4→5 数据契约 |
| Developer / QA / Reviewer | `agents/core/developer.md` etc. | HDL 编码执行者 |
