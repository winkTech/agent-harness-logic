---
name: architecture-gate-checklist-p1b
title: Phase 1b 门禁检查清单 — 微架构设计
domain: fpga
type: checklist
tags: [fpga, microarchitecture, gate, checklist]
updated: 2026-07-03
---

# Phase 1b 门禁检查清单 — 微架构设计

> 调度层在 Phase 1b 产出后执行此检查。
> **全部 [MUST] 通过**才能进入 Phase 2（定点量化）。

---

## B1 — 架构空间探索

| # | 检查项 | 级别 | 检查方法 |
|---|--------|------|----------|
| 1 | **至少 2 种微架构方案**（全并行/半折叠/全串行/脉动阵列） | MUST | architecture_tradeoff.md 中方案数 ≥ 2 |
| 2 | 对比维度包含面积、延迟、吞吐、预估 Fmax | MUST | 检查对比表 ≥ 4 列 |
| 3 | 对比表有定量数据（DSP48/LUT 数字，不是"多/少"定性） | MUST | grep 数字 + "DSP\|LUT\|cyc\|MHz" |
| 4 | 选择最优方案有明确理由（为什么适合这个系统） | MUST | 理由与 A1 系统约束对应 |
| 5 | 被否方案有注明为什么不选 | MUST | grep "不选\|放弃\|劣势\|代价" |

---

## B2 — 资源预算跟踪

| # | 检查项 | 级别 | 检查方法 |
|---|--------|------|----------|
| 6 | 算法工程师给的资源预算有记录并引用 | MUST | resource_budget_tracking.md 开头有预算数字 |
| 7 | 每个数据通路结构的资源消耗已逐级累加 | MUST | 检查有"累计"或"小计"行 |
| 8 | 已用 vs 预算的对比数据已计算（比例/百分比） | MUST | grep "%\|比例\|used/budget" |
| 9 | 超预算 10% 有告警记录 | MUST | grep "超\|告警\|⚠️" |
| 10 | 如果超预算 → 有缓解方案（折叠/降位宽/换架构） | MUST | grep "缓解\|方案\|改为\|降位宽" |

---

## B3 — 时序预估

| # | 检查项 | 级别 | 检查方法 |
|---|--------|------|----------|
| 11 | 每级的组合逻辑级数已估算 | MUST | timing_estimate.md 每级有组合逻辑级数数字 |
| 12 | 关键路径已标注（哪条路径最长） | MUST | grep "关键路径\|critical\|瓶颈" |
| 13 | Pipeline 插入方案已给出（在哪插、插多少级、延迟代价） | MUST | grep "pipeline\|寄存器\|插入" |
| 14 | 跨时钟域路径已标注及 CDC 方案 | MUST | grep "CDC\|跨时钟" |
| 15 | 预估 Fmax 与目标 Fmax 对比已做 | SHOULD | grep "Fmax.*vs\|目标" |

---

## B4 — 接口契约设计

| # | 检查项 | 级别 | 检查方法 |
|---|--------|------|----------|
| 16 | **所有端口定义了握手协议**（valid-ready/请求-确认/流控使能） | MUST | interface_contract.md 每端口有协议类型 |
| 17 | 背压传播方式已描述（反压从前级到后级传播需要多少 cycle） | MUST | grep "背压\|反压\|backpressure" |
| 18 | 反压链长度限制已标注（最长允许多少级反压链） | MUST | grep "长度\|限制\|depth" |
| 19 | 错误传播策略已定义（丢弃/重传/错误标记） | MUST | grep "错误\|error\|丢弃\|重传" |
| 20 | **时序图包含以下三种场景**: 正常传输、反压、错误 | MUST | 检查是否有波形描述或 ASCII 时序图包含 3 种场景 |
| 21 | architecture.yaml 的端口与 interface_contract.md 一致 | MUST | 交叉检查端口名和位宽 |

---

## B5 — 验证感知设计

| # | 检查项 | 级别 | 检查方法 |
|---|--------|------|----------|
| 22 | 每子模块的自检方法已定义（自动比对/波形 dump/断言） | MUST | verification_strategy.md 逐模块有自检方案 |
| 23 | 关键信号可观察性已保障（debug 总线/状态寄存器） | MUST | grep "debug\|观察\|dump\|monitor" |
| 24 | 调试 hook 已预留（performance monitor/错误计数器） | SHOULD | grep "hook\|performance monitor\|错误计数" |
| 25 | 覆盖率收集策略已定义（哪些信号需要 cover property） | MUST | grep "coverage\|cover\|覆盖率" |

---

## B6 — 时钟域分析

| # | 检查项 | 级别 | 检查方法 |
|---|--------|------|----------|
| 26 | 时钟域图已给出（列出所有时钟及频率、相位关系） | MUST | clock_domain.md 有时钟列表 |
| 27 | 每个模块归属哪个时钟域已标注 | MUST | grep 每个模块名和对应时钟 |
| 28 | **所有跨时钟域信号清单完整**（无漏同步） | MUST | CDC 清单表格包含信号名、源时钟、目标时钟、CDC 方案 |
| 29 | 每路 CDC 信号的同步方案已定义（双寄存/异步 FIFO/握手） | MUST | 每路 CDC 信号有对应方案 |
| 30 | 异步 FIFO 深度计算已做（读写时钟比 × 最大突发长度） | MUST | grep "深度\|depth.*计算\|async fifo depth" |

---

## 🔴 额外红线检查

| # | 检查项 | 级别 | 检查方法 |
|---|--------|------|----------|
| 31 | **全部模块复位信号为 `i_rst`（同步高有效），无 `rst_n`/`reset_n`/`arst`** | 🔴 **红线** | grep -i "rst_n\|reset_n\|arst" architecture.yaml interface_contract.md |
| 32 | 没有违反 B4 的"接口握手未定义" | MUST | 没定义的端口列表 = 空 |
| 33 | 没有违反 B6 的"CDC 漏同步" | MUST | CDC 清单覆盖率 100% |
| 34 | architecture.yaml 流程/FSM/位宽与各文档一致 | MUST | 交叉检查 4 项关键字段 |
| 35 | 所有估算不能只是定性（必须有数字） | MUST | 检查 resource_budget 和 timing_estimate 有数字 |
| 36 | 微架构方案不跳过一个模块（每个待实现模块都覆盖） | MUST | architecture.yaml modules 列表完整 |

---

## 📋 总体判定

```
P1b 门禁结果:
  MUST 通过: ___/30 项 (要求: 全部通过)
  SHOULD 通过: ___/5 项
  🔴 红线: ___/6 项 (要求: 全部通过 — 零容忍)
  ⛔ 阻断项: __________
  判定: 🔴 FAIL / 🟢 PASS
```

## 通过 → Phase 2

以下条件自动进入 Phase 2（定点量化）：
- 全部 30 项 [MUST] ✅
- 全部 6 项 [🔴 红线] ✅（**复位/接口/CDC/架构一致性 — 零容忍**）
- architecture.yaml 通过了完整性检查（modules/pipeline/FSM/位宽/latency 字段都存在）

## 不通过 → 退回修改

- 列出未通过项（按 B1-B6 分组）
- **红线违规立即退回，不需讨论**
- 涉及的工程师（算法/逻辑）修正各自部分
- 修正后复查 architecture.yaml 完整性 + 门禁检查
