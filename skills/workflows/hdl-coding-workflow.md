---
name: hdl-coding-workflow
description: RTL 开发全流程 — 算法分析→架构设计→定点量化→TB向量生成→逐模块RTL+脚本化对比→证据门禁→顶层全链仿真→回归→审查→报告
version: 3.4.0
agents: [developer, qa, code-reviewer, adversarial-verifier]
phases: 10
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
- **微架构先行 [NEW]**: Phase 1 必须产出流水线结构/FSM 状态图/数据通路的正式文档，作为 RTL 编码的刚性契约
- **逐模块验证 + 脚本化证据 [MUST]**: 每模块写完后必须生成 check_<module>.py 脚本，自动仿真对比 MATLAB golden，输出 JSON 证据文件至 03_sim/check_results/
- **验证归逻辑工程师 [NEW]**: 所有 RTL 验证/TB/调试/对比脚本全部由逻辑工程师负责，调度层不直接修改
- **证据门禁 [NEW]**: Phase 4.5 独立从磁盘读取 JSON 证据文件，不信任 Phase 4 自述；高安全模块追加对抗 agent 读源码找差异
- **全链联调 [MUST]**: Phase 4.5 通过后方可搭建顶层，全链逐级与 golden model 对比
- **最终输出 bit-true 对齐 [NEW]**: RTL 最终输出必须与定点 Golden Model 逐比特对齐，允许定点精度损失，不允许算法方向偏离
- **检查点暂停 [NEW]**: Phase 1/2/3/4.5/5/7 完成后产出 artifact，暂停等待用户审查确认后再继续
- **目录合规 [NEW]**: Phase 0 按 `cross-project-experience.md` 标准建目录，所有文件归位。违规 = FAIL
- **用完即清理 [NEW]**: 仿真 transient 文件（work/ transcript *.wlf）在 Phase 后 `make clean`，不留垃圾
- **验证左移**: 每层有检查点，仿真日志实时可读
- **不可跳越**: Phase N 产出是 Phase N+1 输入
- **3-迭代复盘规则**: 同一问题迭代 ≥ 3 次时，执行 `workflows/debug-retrospective.md`

---

## Phase 列表

| Phase | 责任人 | 目标 | 检查点 | 透明产出 |
|:------|:-------|:-----|:--------|:---------|
| **0** 基础设施 | 调度层 | ① **按 `cross-project-experience.md` 标准建目录** ② 统一 EDA 工具接口 (make lint/compile/sim/regress) ③ 文件清单 + .gitignore | Makefile + `.f` 创建，`make lint`/`compile` 通过，**目录结构符合跨项目标准** | ✅ **目录结构 + .gitignore → 用户审查后再进 P1** |
| **1** 架构设计 | **算法工程师** | 算法文档化 + 顶层框图 + **微架构拆解（流水线/FSM/位宽映射）** + 对称对分析 + architecture.yaml | algorithm_spec + architecture.yaml (含 pair_conventions + **流水线结构 + FSM 状态图 + 数据通路位宽**) + 框图 | ✅ **architecture.yaml + pipeline_diagram.md → 用户审查后进 P2** |
| **2** 定点量化 | **算法工程师** | 位宽扫描 + bit-true 定点模型 + DSP/LUT/BRAM 预算表 | fixed_point_report + resource_estimate 在预算内 | ✅ **fixed_point_report.md + 资源表 → 用户审查后进 P3** |
| **3** TB+向量生成 | **逻辑工程师** (TB框架) + **算法工程师** (向量) | 自检 Testbench + SVA 断言 + MATLAB golden 测试向量生成 | TB 编译通过，自检逻辑完整，测试向量已生成 | ✅ **TB + 向量清单 → 用户审查后进 P4** |
| **4** 逐模块RTL+脚本化对比 | **逻辑工程师** | **[MUST]** 每模块: 写RTL → 生成 check_<module>.py → bash运行 → 输出 JSON 证据至 02_sim/check_results/ → 下一模块 | 验证矩阵全 ✅ + 每模块 .json 证据文件 (status=PASS, compared_points>0) | ✅ **验证矩阵 + 每模块 JSON → 用户可读** |
| **4.5** 证据门禁 | **调度层** (fs检查) + **对抗 agent** (高安全模块) | 标准模式: fs 读 JSON 证据 (0 token). 高安全模式: 追加独立对抗 agent 读 RTL+MATLAB golden 找差异. 不过 → 阻止 Phase 5 | 文件检查全部 PASS, 高安全模块无逻辑差异 | ✅ **门禁报告 → 用户审查后进 P5** |
| **5** 顶层集成+全链仿真 | **逻辑工程师** | **[MUST]** 入口依赖 Phase 4.5 通过. 搭建顶层 → 全链逐级对比MATLAB golden. **最终输出必须与定点 Golden Model bit-true 对齐 (允许定点精度损失，不允许算法方向偏离)** | 全链各中间级与 golden model 一致，无 FAIL | ✅ **全链仿真日志 + 逐级对比表 → 用户审查** |
| **6** 回归覆盖率 | **逻辑工程师** | 全量回归 + mandatory 覆盖点 100% | `make regress` 全绿，covergroup 全部触发 | — |
| **7** 代码审查 | **code-review agent** | 自审查清单 + 代码审查 + 模型一致性检查 | 审查通过，仿真日志 + 覆盖率报告完备 | ✅ **审查报告 → 用户审查** |
| **8** 报告输出 | 调度层 | 汇总实现报告 + 文档归档 + 经验记录 | 报告完成，文档归档，经验已记录 | ✅ **最终报告** |

### 检查点暂停规则 [NEW]

1. **Phase 1/2/3/4.5/5/7 完成后必须暂停**，产出可读 artifact
2. 调度层将 artifact 呈现给用户，等待确认
3. 用户确认后，调度层才推进到下一 Phase
4. 用户可要求调整方案后再继续
5. 未确认不得跨 Phase——这是刚性约束

### RTL ↔ Golden Model 对齐标准 [NEW]

- RTL 逐模块输出必须与定点 Golden Model 的对应中间值 **按周期按比特对齐**
- 允许差异仅限定点精度损失（如乘积截位、饱和处理）
- **不允许的差异**：算法方向偏离（如硬判决 vs 软判决、时域 vs 频域）、流水线级数/握手时序偏离架构方案
- 最终验证报告必须注明：`compared_points`, `max_error_lsb`, `算法方向一致性: 通过/未通过`

## 模块安全分类

工作流根据模块类型自动选择验证模式：

| 模式 | 适用模块 | 验证手段 | Token 成本 |
|:-----|:---------|:---------|:-----------|
| **标准模式** | LFSR/CRC/FIR/串并转换/位宽截位/延时同步/PRBS | 脚本对比 + JSON 证据 → fs 文件门禁 | **−2780/轮** (比原工作流更省) |
| **高安全模式** | 均衡器/Viterbi/FFT/载波恢复/反馈环路/自适应算法/CORDIC | 同上 + 独立对抗 agent 读 RTL+MATLAB 源码 | +~3200 (仅对高安全模块) |

自动分类基于模块名关键词匹配（`equalizer`, `fft`, `viterbi`, `feedback` 等），可通过 `securityModules` / `standardModules` 参数覆盖。

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
