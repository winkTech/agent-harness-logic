---
name: hdl-coding-workflow
description: RTL 开发全流程 — 系统方案→微架构→定点量化→TB向量生成→逐模块RTL+脚本化对比→确定性证据门禁→顶层全链仿真→回归→双维审查→报告
version: 3.6.0
executable: workflows/hdl-coding-dag-workflow.js
agents: [algorithm-engineer, logic-engineer, ce-correctness-reviewer, ce-api-contract-reviewer, ce-architecture-strategist, ce-performance-oracle]
phases: 11
triggers:
  - new algorithm module
  - new RTL module
  - testbench creation
  - resource evaluation
  - code review prep
---

# HDL Coding Workflow (v3.6)

> **本文档是方法论说明；可执行的单一真源是 `workflows/hdl-coding-dag-workflow.js`**，
> 通过 `Workflow({name: 'hdl-coding-dag-workflow', args: {...}})` 调用
> （`hdl-coding-workflow` 为向后兼容别名）。两者如有出入，以 js 为准。

## 核心原则

- **自顶向下**: 先系统方案 (P1a)，再微架构 (P1b)，再代码
- **Golden Model 绝对权威**: 定点和 RTL 都围绕 Golden Model 展开
- **RTL ↔ MATLAB 严格对标**: RTL 每模块必须与 MATLAB 模型的步骤一一对应
- **微架构先行**: P1b 必须产出流水线结构/FSM 状态图/数据通路的正式文档 (architecture.yaml)，作为 RTL 编码的刚性契约
- **逐模块验证 + 脚本化证据 [MUST]**: 每模块写完后必须生成 check_<module>.py 脚本，自动仿真对比 MATLAB golden，输出 JSON 证据文件至 `02_sim/check_results/`
- **确定性证据门禁 [MUST]**: 证据判定由 `engine/scripts/hdl-evidence-gate.cjs` 完成（读磁盘、输出 JSON + RESULT: PASS/FAIL）；工作流派证据 agent 执行它并按 schema 原样带回，不信任任何 agent 自述
- **验证归逻辑工程师**: 所有 RTL 验证/TB/调试/对比脚本由 logic-engineer 负责；向量生成与定点归 algorithm-engineer；审查归 ce-* 只读审查员
- **全链联调 [MUST]**: Phase 4.5 通过后方可搭建顶层，全链逐级与 golden model 对比
- **最终输出 bit-true 对齐**: RTL 最终输出必须与定点 Golden Model 逐比特对齐，允许定点精度损失，不允许算法方向偏离
- **可恢复检查点**: preflight / design-review / evidence-review 未确认时工作流暂停（抛 `[WorkflowCheckpoint:<name>]`），用户审查后带确认参数 + `resumeFromRunId` 续跑，已完成阶段走缓存
- **目录合规**: Phase 0 按 `cross-project-experience.md` 标准建目录，产出 `var/project-init/directory-contract.json`
- **用完即清理**: 仿真 transient 文件（work/ transcript *.wlf）在 Phase 后 `make clean`
- **不可跳越**: Phase N 产出是 Phase N+1 输入；调试循环封顶 5 次，超限转人工审查（复杂调试加载 `debugging` skill）

---

## Phase 列表

| Phase | 责任 Agent | 目标 | 检查点 |
|:------|:-----------|:-----|:--------|
| **0** 基础设施 | 调度层 | 按跨项目标准建目录 + Makefile (lint/compile/sim/clean) + .gitignore + directory-contract.json | make lint/compile 通过 |
| **1a** 系统方案设计 | algorithm-engineer | A1-A6: 系统上下文/数学推导/多方案对比/信号链/定界/定点策略 → 06_doc/ 六份文档 | gate-checklist-p1a.md |
| **1b** 微架构设计 | algorithm-engineer ∥ logic-engineer | 模块分解+接口契约 (architecture.yaml) ∥ B1-B6 资源/时序/CDC 评估；arch 存在性由证据门禁脚本校验 | gate-checklist-p1b.md → **CP: design-review** |
| **2** 定点量化 | algorithm-engineer | 位宽扫描 + bit-true 定点模型 + DSP/LUT/BRAM 预算表 | 资源在预算内 |
| **3** TB+向量生成 | logic-engineer (TB) ∥ algorithm-engineer (向量) | 自检 TB + SVA + MATLAB golden 向量 (GM 先自检) | TB 编译通过 |
| **4** 逐模块RTL+脚本化对比 | logic-engineer (编码/仿真/调试) + ce-correctness-reviewer (独立裁决/终验) | 每模块: RTL → 仿真 → 证据门禁单模块校验 → (FAIL 时 Debugger↔Reviewer 双视角循环, 封顶 5 次) | 每模块 gate_ok + compared_points>0 |
| **4.5** 证据门禁 | hdl-evidence-gate.cjs (确定性) + ce-correctness-reviewer (高安全模块对抗) | 脚本校验全部模块 JSON 证据；高安全模块追加对抗 agent 读 RTL+golden 找差异 | 全部 PASS → **CP: evidence-review** |
| **5** 顶层集成+全链仿真 | logic-engineer (集成/修复) + ce-api-contract-reviewer / ce-architecture-strategist / ce-performance-oracle (三路只读分析) | 4 路发散 (接口/数据通路/Golden/时序) → 合成 → 定向修复 | 全链各中间级与 golden 一致 |
| **6** 回归覆盖率 | logic-engineer | make regress 全量回归 + covergroup 100% | regress 全绿 |
| **7** 代码审查 | ce-correctness-reviewer ∥ ce-api-contract-reviewer | 正确性维度 + 接口契约维度双审查 | 审查通过 |
| **8** 报告+Verifier | 调度层 | 汇总报告 + 归档 + make clean；末端 verifier 交叉核对全链证据 | verifier pass=true |

## 检查点体系

| 检查点 | 位置 | 确认方式 |
|:-------|:-----|:---------|
| `preflight` | 工作流入口 | `args.confirmed=true` |
| `design-review` | P1b 之后、P2/P3 之前 | `args.checkpoints['design-review'].confirmed=true` |
| `evidence-review` | P4.5 之后、P5 之前 | `args.checkpoints['evidence-review'].confirmed=true` |
| `verifier` | 末端（自动） | verifier 返回 pass=true，无需用户确认 |

未确认的检查点使工作流以 `[WorkflowCheckpoint:<name>]` 暂停；用户审查产出后带确认参数 +
`resumeFromRunId` 重跑，已完成的 agent 调用命中前缀缓存、零成本跳过。
无人值守场景显式传 `args.confirmAllCheckpoints=true`。

## 模块安全分类

| 模式 | 适用模块 | 验证手段 |
|:-----|:---------|:---------|
| **标准模式** | LFSR/CRC/FIR/串并转换/位宽截位/延时同步/PRBS | 脚本对比 + JSON 证据 → hdl-evidence-gate.cjs 确定性判定 |
| **高安全模式** | 均衡器/Viterbi/FFT/载波恢复/反馈环路/自适应算法/CORDIC | 同上 + ce-correctness-reviewer 对抗读 RTL+MATLAB 源码 |

自动分类基于模块名关键词匹配（`equalizer`, `fft`, `viterbi`, `feedback` 等），可通过
`securityModules` / `standardModules` 参数覆盖。

---

## 关联资源

| 资源 | 路径 | 用途 |
|------|------|------|
| 可执行工作流（单一真源） | `workflows/hdl-coding-dag-workflow.js` | DAG 定义、检查点、agent 接线 |
| 证据门禁脚本 | `engine/scripts/hdl-evidence-gate.cjs` | Phase 1b/4/4.5 确定性证据判定 |
| HDL 编码规范 | `skills/hdl-coding/SKILL.md` | 命名规则、时序安全、lint 门禁 |
| 算法→Verilog 参考 | `skills/hdl-coding/references/alg-flow-verilog.md` | 代码模板、NMSE 判定、排查表 |
| 各 Phase 详细说明 | `skills/workflows/hdl-coding/` | phase0-8 文档（P1 文档覆盖 P1a/P1b） |
| P1a/P1b 门禁清单 | `engineering-assets/knowledge/primary/architecture-patterns/gate-checklist-p1a.md` / `gate-checklist-p1b.md` | design-review 检查点核对表 |
| 证据 JSON 契约 | `schemas/check-result.schema.json` | check_<module>.py 输出格式 |
| Code Review 工作流 | `skills/workflows/code-review-workflow.md` | Phase 7 之外的独立审查入口 |
| 调试方法论 | `skills/debugging/SKILL.md` | Phase 4 调试循环超限时加载 |
| Agent 定义 | `agents/domain/algorithm-engineer.md` / `agents/domain/logic-engineer.md` / `agents/compound/ce-*.md` | 责任分工的执行者 |
