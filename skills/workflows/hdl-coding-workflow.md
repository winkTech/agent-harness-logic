---
name: hdl-coding-workflow
description: RTL 开发全流程 — 算法分析→架构设计→定点量化→Testbench-First→增量仿真→透明调试
version: 3.0.0
agents: [developer, qa, code-reviewer]
phases: 8
complexity: high
triggers:
  - new algorithm module
  - new RTL module
  - testbench creation
  - resource evaluation
  - code review prep
---

# HDL Coding Workflow (v3)

RTL 开发全流程。核心原则：

- **自顶向下**: 先架构框图，再模块方案，再代码
- **Golden Model 绝对权威**: Golden Model 是设计的唯一真实来源（Single Source of Truth）。
  定点和 RTL 都围绕它展开，有出入以 Golden/定点模型为准
- **RTL ↔ MATLAB 严格对标**: RTL 每个模块必须与 MATLAB 模型的步骤一一对应，
  不可缺斤少两。验证时相同输入必须输出与定点模型一致的结果
- **验证左移**: 每层有检查点，仿真日志实时可读
- **不可跳越**: 阶段 N 的产出是阶段 N+1 的输入
- **LUT/映射模块额外门禁**: 涉及星座映射/查找表/比特-符号编码的模块，在 Phase 2
  必须做逐点映射验证，Phase 4 必须做映射预验证三件套（固定序列→全星座点→背压），
  不通过不得进入 Layer 3 数据通路仿真。详见各 Phase 文档。
- **3-迭代复盘规则**: 同一问题的修复迭代 ≥ 3 次时，暂停调试，执行复盘（
  `workflows/debug-retrospective.md`）。提取流程漏洞并更新工作流文件后再继续。
  每次复盘都是在加固流程，不让同类问题再次浪费迭代。

---

## Phase 0: 基础设施统一层

**目标**: 统一 EDA 工具接口，建立可复用的构建系统。

- 工具抽象层 — `make lint` / `compile` / `sim` / `regress`
- Makefile 模板 + 多工具链实现（Questa/VCS/Xcelium/Verilator）
- 文件清单管理 (`.f` 文件)

**检查点**: 选定工具链，Makefile + filelists 创建完成，`make lint`/`compile` 通过。
→ 详见 [`hdl-coding/phase0-infrastructure.md`](hdl-coding/phase0-infrastructure.md)

---

## Phase 1: 算法分析与架构设计

**目标**: 写代码前完成算法文档化、架构框图、模块难点分析。

- 算法规格文档（数学推导、参数空间、时序约束）
- RTL 顶层架构框图（模块↔MATLAB 函数对标）
- 每模块逐一分析：接口/方案/难点/监测/鲁棒性
- 浮点 golden model + 测试向量 + 性能基线

**检查点**: algorithm_spec + 架构框图 + 所有模块方案 + golden_model 通过。
→ 详见 [`hdl-coding/phase1-architecture.md`](hdl-coding/phase1-architecture.md)

---

## Phase 2: 定点量化与资源评估

**目标**: 数据驱动确定位宽、量化策略和资源预算。

- 位宽扫描与量化策略比较
- Bit-true 定点模型重构
- DSP/LUT/BRAM 预算表（超标回退 Phase 1）

**检查点**: fixed_point_report + resource_estimate 完成，资源预算在约束内。
→ 详见 [`hdl-coding/phase2-fixed-point.md`](hdl-coding/phase2-fixed-point.md)

---

## Phase 3: Testbench-First

**目标**: 先写能自动判断对错的 testbench，再写 RTL。

- 比对策略：周期精确 / 事务级 / Scoreboard
- 自检 Testbench + SVA 断言 + 结构化日志

**检查点**: testbench 编译通过，自检逻辑完整，SVA 无编译错误。
→ 详见 [`hdl-coding/phase3-testbench.md`](hdl-coding/phase3-testbench.md)

---

## Phase 4: 增量式 RTL 编码（分层验证）

**目标**: 从最小可验证单元开始，每层仿真绿灯再推进。

- 层间依赖分析 + Stub 机制处理交织依赖
- 短仿真/长仿真运行方式
- 双通道日志 + 完成标记 + Bash 轮询

**检查点**: Layer 0-4 依次通过，日志无 FAIL。
→ 详见 [`hdl-coding/phase4-incremental-rtl.md`](hdl-coding/phase4-incremental-rtl.md)

---

## Phase 5: 回归 + 覆盖率

**目标**: 确保改动不破坏已有功能，覆盖关键路径。

- 全量回归（`make regress`）
- Mandatory 覆盖点 100% / informative 趋势参考
- Golden Model 覆盖率映射

**检查点**: 回归全绿 + mandatory covergroup 全部触发。
→ 详见 [`hdl-coding/phase5-regression.md`](hdl-coding/phase5-regression.md)

---

## Phase 6: 代码审查

**目标**: 确认代码质量、流程合规性。

- 自审查清单（构建/日志/CDC/复位/SVA/Stub）
- 提交 `code-review` 质量审查

**输出**: 审查通过的 RTL + 仿真日志 + 覆盖率报告。
→ 详见 [`hdl-coding/phase6-code-review.md`](hdl-coding/phase6-code-review.md)

---

## Phase 7: 报告输出

**目标**: 汇总各阶段文档，形成完整交付包。

- 实现报告（架构/定点/资源/性能/难点回顾）
- 文档归档 + 经验记录

**检查点**: 报告完成，文档归档，经验已记录。
→ 详见 [`hdl-coding/phase7-report.md`](hdl-coding/phase7-report.md)

---

## 仿真调试透明化对照表

| 传统方式 | v3 方式 | 区别 |
|---------|--------|------|
| 直接写 RTL | 先架构框图+模块方案+难点分析 | 代码前已有完整设计规划 |
| 凭经验估算定点位宽 | Phase 2 定点扫描驱动位宽选择 | 量化决策有数据支撑 |
| 资源靠猜 | Phase 2 基于定点+架构框图的资源评估 | 资源预算可追踪可验证 |
| 写完再仿真 | 写一段仿一段 | 故障定位从小时级→分钟级 |
| 人工看波形 | 自动比对 golden model | 发现错误从"感觉不对"→"第 N 个 cycle 数据不匹配" |
| testbench 一次性写 | Testbench-First 分层写 | 每层是独立检查点，不互相阻塞 |
| 仿真沉默运行 | 双通道日志（`$display` + `$fwrite`） | 崩溃不丢日志，长仿真可靠轮询 |
| 单一工具链绑定 | 工具抽象层（TAL）+ Makefile | 切换工具链只需改一行变量 |
| 线性层推进 | 依赖图 + Stub 机制 | 复杂依赖不阻塞增量开发 |
| 周期精确固定比对 | 三种比对模式可选 | 适应流水线延迟、握手反压、无序输出 |
| 功能覆盖率 90% 硬红线 | mandatory 100% + informative 趋势参考 | 覆盖率有区分，不因不可能的组合阻塞审查 |
| 最终 PASS/FAIL 一行 | 逐层进度 + 每 cycle 比对 | 看到"走到哪了、哪一步错了" |

## 关联资源

| 资源 | 路径 | 用途 |
|------|------|------|
| HDL 编码规范 | `skills/hdl-coding/SKILL.md` | 命名规则、时序安全、lint 门禁 |
| 算法→Verilog 参考 | `skills/hdl-coding/references/alg-flow-verilog.md` | 代码模板、NMSE 判定、排查表 |
| TDD 工作流 | `skills/tdd/SKILL.md` | Testbench-First 方法论 |
| Code Review 工作流 | `workflows/code-review-workflow.md` | Phase 6 审查环节 |
| Debug 复盘工作流 | `workflows/debug-retrospective.md` | Phase 4 迭代≥3次时触发 |
| MATLAB MCP | `CLAUDE.md` | Golden model 生成与验证 |
| Project Spec Schema | `schemas/hdl-project-spec.schema.json` | Phase 1→3 数据契约 |
| Layer Status Schema | `schemas/hdl-layer-status.schema.json` | Phase 4→5 数据契约 |
| 检查点脚本 | `.claude/checkpoints/hdl-checkpoints.sh` | 各 Phase 可执行断言 |
| Developer Agent | `agents/core/developer.md` | HDL 编码执行者 |
| QA Agent | `agents/core/qa.md` | 回归/覆盖率验证 |
| Code Reviewer Agent | `agents/specialized/code-reviewer.md` | 代码审查 |
