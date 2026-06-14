---
name: agent-workflow-refinement
description: "2026-06-14 Agent 和工作流优化 — 架构拆解缺失、验证归属不清、不透明"
metadata:
  type: feedback
  domain: meta
---

# Agent + 工作流优化 (2026-06-14)

卷积编码+Viterbi 译码项目（hdl-coding-workflow）暴露了三个流程缺陷，已修复：

## 缺陷 1：架构拆解缺失

**问题**：Phase 1 只产出模块接口列表 (architecture.yaml)，缺少微架构方案。RTL 编码时直接跳到了具体实现，流水线级数和 FSM 结构没有正式文档。

**修复**：Phase 1 增加 `pipeline_diagram.md` 产出，包含：
- 流水线结构（每级功能/延迟/握手方式）
- FSM 状态图（状态/转移/输出）
- 数据通路位宽映射（每级 I/O 位宽、Q 格式）

→ 改 `algorithm-engineer.md`（核心工作 §2 新增）+ `hdl-coding-workflow.md` Phase 1 描述 + `hdl-coding-dag-workflow.js` P1 prompt

**Why**：没有微架构方案就写 RTL，导致验证阶段才发现流水线对齐问题，而这时已经有很多代码依赖难以调整。微架构方案是 RTL 的刚性契约。

## 缺陷 2：验证归属不清

**问题**：调度层（我）在调试阶段直接修改了 TB 比较逻辑和 SMU 地址位宽——这些本应由逻辑工程师完成。

**修复**：在 `logic-engineer.md` 验证责任铁律中明确：
- TB/自检脚本/仿真调试/波形分析/对比逻辑修复 → 全部归逻辑工程师
- 调度层不直接修改 `.sv` / `tb_*.sv` / `check_*.py`
- 调度层角色：组织流程、呈报 artifact、协调争议

**How to apply**：任何时候需要改 RTL/TB，调度层应唤醒逻辑工程师 agent 处理，而非直接改。

## 缺陷 3：不透明

**问题**：Agent 在后台工作，用户看不到中间产出和决策过程。

**修复**：Phase 1/2/3/4.5/5/7 产出 artifact 后**暂停**，等待用户审查确认：
- 每次暂停呈报该 Phase 的 artifact（方案文档/数据/报告）
- 用户确认后再进下一 Phase
- 违反暂停规则 = 流程违规

**How to apply**：调度层执行 workflow 时，必须遵守检查点暂停规则。每个关键 Phase 完成后主动产出 artifact 并等待用户指令。

---

## 第二轮评审 (2026-06-14 下午)

用户又指出的 2 个问题 + 自评审发现的 10 个问题：

### 用户指出
| # | 问题 | 修复 |
|:-:|:-----|:------|
| 4 | 目录不按跨项目标准建 | Phase 0 prompt 直接引用 `cross-project-experience.md` 标准目录 |
| 5 | 仿真文件不清理 | Phase 8 加 `make clean`、.gitignore 排除 transient、Makefile clean 目标 |

### 自评审发现
| # | 严重度 | 问题 | 修复方法 |
|:-:|:------:|:-----|:---------|
| 6 | 🔴 P0 | **路径幽灵**：Phase 4 引用 `05_result/sim/` 不存在 | 改为 `02_sim/` |
| 7 | 🔴 P0 | **Phase 3 混淆**：一个 agent 同时干 TB（逻辑工程师）+ 向量（算法工程师） | 拆分为 `parallel()` 两个 agent |
| 8 | 🔴 P0 | **Lite 模式断裂**：跳过 Phase 2 后 Phase 4 引用定点报告为空 | 添加 Lite 模式 fallback 消息 |
| 9 | 🟡 P1 | **GM 未预检**：Phase 3 直接生成向量，不确认 GM 正确 | 向量子任务第 0 步执行 GM 自检 |
| 10 | 🟡 P1 | **check_results/ 无主**：没人保证目录存在 | Phase 0 创建 + Phase 4 自我确保 |
| 11 | 🟡 P1 | **缺 lint 门禁**：Phase 4 只检查 compile 不检查 lint | 加 b) make lint 通过 |
| 12 | 🟡 P1 | **architecture.yaml 无校验**：自然语言无法检查完整性 | 后处理读文件检查必填字段 |
| 13 | 🔵 P2 | **Pre-flight 不阻塞**：问题照问但 Workflow 照跑 | 仅记录，未改（Workflow 脚本限制） |
| 14 | 🔵 P2 | **无版本记录** | 仅记录，未改 |
| 15 | 🔵 P2 | **模块间不清理** | Phase 4 每模块加 `make clean` |

### 改动文件

- `hdl-coding-dag-workflow.js`：
  - Phase 0 prompt → 直接引用跨项目标准目录
  - Phase 1 prompt → 要求写入文件 + 后处理 schema 校验
  - Phase 3 → `parallel()` 拆分 TB(逻辑工程师) + 向量(算法工程师, 含 GM 预检)
  - Phase 4 prompt → `05_result/`→`02_sim/`、加 lint 门禁、模块间清理
  - Lite 模式 → 定点报告 fallback
  - Phase 8 → 加 `make clean` 清理指令
- `hdl-coding-workflow.md`：
  - 核心原则加「目录合规」「用完即清理」
  - Phase 0 引用跨项目标准

## 关联

[[hdl-golden-model-philosophy]] — Golden Model 绝对权威
[[instruction-compliance]] — 指令绝对优先
[[project-directory-cleanup-discipline]] — 目录标准 + 清理纪律
[[cross-project-experience-ref]] — 跨项目标准目录
