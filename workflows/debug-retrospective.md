---
name: debug-retrospective
description: 迭代≥3次后自动触发复盘 — 提取根因→定位流程漏洞→更新工作流文件
version: 1.0.0
phase: hdl-coding-phase-4
trigger:
  condition: problem_iterations >= 3
  description: 同一问题的修复迭代达到3次以上，说明流程存在系统性漏洞
---

# Debug Retrospective（复盘工作流）

## 触发条件

| 条件 | 说明 |
|:-----|:------|
| **迭代≥3次** | 同一问题经过3轮以上尝试才解决 |
| **同一根因扩散** | 一个根因导致多个表面症状，每轮只修一个症状 |
| **同一类错误跨模块复发** | 比如A模块出现位序错误→B模块也出现 |

触发时暂停当前工作，执行本流程。

---

## 流程

### Step 1: 解构问题（5 Whys）

回答以下问题：

```
1. 表面现象是什么？（仿真报了哪个错）
2. 直接原因是什么？（哪行代码/哪个参数错了）
3. 为什么没在第一轮发现？（跳过了哪个检查环节）
4. 流程中缺了什么？（哪个 Phase/检查点本应拦截但没拦截）
5. 如何阻止同类问题再次发生？（更新哪个工作流文件/检查点）
```

→ 输出：`root_cause_summary`

### Step 2: 定位流程漏洞

对照当前工作流阶段，标记漏洞位置：

```
□ Phase 1 (架构)     — 是否缺了映射/位序文档化？
□ Phase 2 (定点)     — 是否跳过了逐点验证？
□ Phase 3 (Testbench)— 是否缺了帧参数/符号计数断言？
□ Phase 4 (RTL编码)  — 是否缺了预验证步骤？
□ Phase 5 (回归)     — 现有回归是否覆盖不到？
□ Phase 6 (审查)     — 审查清单是否缺检此项？
□ 以上皆否             — 全新漏洞类型，新增规则
```

→ 输出：`process_gap_location`

### Step 3: 更新工作流文件

根据 Step 2 的定位，更新对应 Phase 文件：

1. 在对应 Phase 的文档中**新增检查项/约束**
2. 在本文件（debug-retrospective）的 `附录：案例库` 中**追加案例**
3. 同步更新 `auto-lessons.md` 和 `phase-reflection.md` 的经验沉淀

**更新原则**：
- 具体而非抽象：不写"加强验证"这种空话，写可机械执行的步骤
- 可验证：新增的约束必须能通过 grep/lint/脚本自动检查
- 防复发：同类问题在新模块中会被本次新增的规则拦截

→ 输出：`workflow_updates`

### Step 4: 在 session 内存中登记

```markdown
---
name: lesson-<yyyy-mm-dd>-<short-name>
description: <一句话描述本次教训>
metadata:
  type: feedback
  apply_to_phase: <phase-编号>
---

**问题**: <问题现象>
**根因**: <第5个 Why>
**流程漏洞**: <哪个 Phase 缺了什么>
**新增规则**: 
1. <规则1>
2. <规则2>
**关联记忆**: [[auto-lessons]], [[phase-reflection]], [[debug-retrospective]]
```

→ 输出：`lesson_memory`

---

## 迭代计数规则

在 Phase 4 调试过程中，维护一个隐式迭代计数器：

| 模式 | 每次触发迭代+1 |
|:-----|:--------------|
| 改代码后仿真 FAIL | +1 |
| 加 debug 信号重跑 | +1 |
| 换一种实现方式 | +1 |
| 多轮修改同一数据通路 | +1 |

**不计数**的场景（非迭代，而是并行探索）：
- 同时跑多个仿真
- 批量改多个无关模块的 lint 警告

当计数 ≥ 3 时，暂停当前工作，加载本复盘工作流。

---

## 附录：案例库

### 案例 1：modulator 映射对齐（2026-06-07）

| 字段 | 内容 |
|:-----|:------|
| 问题 | RTL 使用 IEEE 802.11 Gray 映射，MATLAB 模型使用非标准映射，两轮修复未对齐 |
| 迭代次数 | 5+ (Gray→16QAM二进制→64QAM公式推导错两次→全星座点字节对齐) |
| 第5个Why | Phase 1 未强制比特流追踪文档化，凭印象实现映射 |
| 流程漏洞 | Phase 1 缺比特序文档化；Phase 2 缺逐点映射验证；Phase 3 缺 TB/向量耦合检查 |
| 新增规则 | Phase 1 比特序文档化、Phase 2 §2.4 映射验证、Phase 3 §3.4 耦合检查、Phase 4 映射预验证三件套 |
| 关联文件 | `hdl-coding/phase1-architecture.md` §1.2, `phase2-fixed-point.md` §2.4, `phase3-testbench.md` §3.4, `phase4-incremental-rtl.md` 映射预验证 |
