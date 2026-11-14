---
adr_number: 'ADR-001'
title: 'AXIS tready 与输出寄存红线的分级判据'
date: '2026-07-31'
status: 'accepted'
supersedes: ''
superseded_by: ''
deciders: ['lihan']
stakeholders: ['owner (lihan)', 'gate-runner/redline-scan 维护', 'CBB 资产作者']
tags: ['redline', 'axi-stream', 'tready', 'output-registration', 'governance']
---

# ADR-001: AXIS tready 与输出寄存红线的分级判据

**Date**: 2026-07-31
**Status**: accepted（裁决：方案 A 分级判据；deciders: lihan, 2026-07-31）

## Context

红线 2 要求"输出由 `ro_` 寄存器驱动，禁止组合直出"（`docs/rules/01-hdl.md`）。RL-OUT v2
（`tools/lib/redline-scan.cjs`）升级后将逐端口机器判定，而治理规矩是**红线不许 waiver**。
这造成一个必须先裁决的问题：**AXIS `tready` 的组合生成算不算红线 2 违例？**

不裁决的后果（`plans/cbb-ip-optimized-wigderson.md` X1）：RL-OUT v2 上线即把 ldpc_codec
打红 → ldpc 转正与红线增强互相死锁。

### 为什么 tready 是特殊的

红线 2 防的是两类真实危害：

1. **跨模块组合链**：输出组合直出 → 多级级联后时序不可控；
2. **接口时序不可预期**：下游看到的是未寄存的胖组合锥。

但 `tready` 与数据类输出有一个结构性区别：把 tready 做成寄存输出而**不损失吞吐**，
唯一通用做法是加 skid buffer（2× 数据宽度寄存器 + 控制）。对数据端口，寄存输出的代价
是一级延迟；对 tready，代价是一整个缓冲结构。AXI-Stream 规范本身允许组合 tready，
真正禁止的是死锁性依赖（tready 组合依赖同拍 tvalid 形成环）。

因此危害分级的关键不是"组合与否"，而是**组合锥里有什么**：

- 锥含 **input 端口**（穿通）：上游 valid / 下游 ready 的组合链会跨模块传播 —— 这正是红线 2 要防的；
- 锥仅含**内部寄存态**（组合-自-寄存）：路径为 reg→若干级 LUT→端口，时序闭合在本模块
  综合报告里可见可控，无跨模块组合链，无 valid↔ready 环。

### 既成事实（本 ADR 只是追认或推翻，不是新发明）

- **rrc 既成判定**：`assign RHS ⊆ REG∪PARAM 且不含 input → pass`（组合-自-寄存），
  RL-OUT v1 按此给 rrc 全绿，已进证据快照；
- **redline-scan.cjs 已按分级判据实现**：`tready 扇入仅内部寄存态则允许`，并留了
  收严的布尔开关（本 ADR accepted 前该逻辑处于"实现先行、裁决缺位"状态）；
- **ldpc_codec 现状**（2026-07-31 实查）：
  - encoder：`s_axis_info_tready = ro_tready`（寄存输出，[ldpc_encoder_top.v:182-186](../../../incubator/intake/ldpc_codec/rtl/ldpc_encoder_top.v)）——已合规，无争议；
  - decoder：`s_axis_llr_tready = ~r_llr_load_done && ~i_busy && ~o_out_active`
    （[ldpc_stream_io.v:97](../../../incubator/intake/ldpc_codec/rtl/ldpc_stream_io.v)），
    资产顶层视角扇入锥 = {`r_llr_load_done`(寄存器), `ro_busy`(寄存器,经端口),
    `r_os != IDLE`(状态寄存器译码)}，**不含任何顶层 input**，特别是不依赖
    `s_axis_llr_tvalid` 与 `m_axis_data_tready` —— 属组合-自-寄存类。

## Decision

**（建议采纳方案 A，最终裁决权在 owner）**

### 方案 A：分级判据（推荐）

`tready` 端口允许组合生成，当且仅当在**资产顶层边界**满足全部三条：

1. 扇入锥 ⊆ 内部寄存态 ∪ 参数/常量（含寄存态的纯组合译码，如 `r_state != IDLE`）；
2. 锥中不含任何顶层 input 端口——特别是不得依赖同接口 `tvalid`（防组合环）与
   下游 `tready`（防跨模块 ready 链）；
3. 其余所有输出端口仍执行红线 2 原判据（寄存/常量驱动，穿通即 FAIL）。

寄存 tready（skid buffer）仍是**默认推荐写法**，`hdl-coding` 模板不变；本判据是库级
底线而非最佳实践。RL-OUT v2 保留收严开关：将来若某器件/频率域实测出问题，可整库
切到方案 B 重扫。

推荐理由：与 AXI-Stream 规范一致；与 rrc 既成判定一致（推翻则 rrc 证据快照连带作废）；
不制造无差别的 skid buffer 面积税；机器可判（redline-scan 已实现）。

### 方案 B：一律寄存（备选，未采纳则留档）

所有 `tready` 必须寄存输出，组合生成一律 FAIL，无豁免。

代价：ldpc decoder 需插入 skid buffer 并重跑 bit-true/时序/资源全套证据（转正推迟约半期）；
rrc 的组合-自-寄存判定连带推翻，快照作废重做；此后每个流式 CBB 承担 skid 面积与验证税。
收益：判据零参数、无灰区；接口时序隔离最彻底。

## Consequences

采纳 A：

- ldpc_codec decoder tready 判 **pass**（锥已实查满足三条件），转正 runbook 解锁；
- redline-scan 的分级逻辑从"实现先行"转为"裁决追认"，`basis` 字段引用本 ADR；
- RL-OUT v2 回归的预期翻红清单中，ldpc tready 项从"待裁决"改为"预期绿"；
- 负面：库里长期存在两类合法 tready 写法，review 时需认知分级判据（由机器门禁兜底）。

采纳 B：

- 判据更简单，但 ldpc 转正推迟半期、rrc 快照作废重做、全库流式模块承担 skid 税；
- `plans/cbb-ip-optimized-wigderson.md` P2/P3 排期需重排。

任一方案：单任务/单资产的**任务级契约可以比库级红线更严**（例如 rtl-bench 的
axis_skid_buffer 任务 spec 明确要求寄存 s_ready），互不冲突——红线是底线，不是上限。

## Alternatives Considered

- **waiver 放行 ldpc**：违反"红线不许 waiver"的治理原则，直接排除；
- **tready 整体豁免出红线 2**（不加锥条件）：会放过 `assign tready = m_tready`（穿通）
  这类真正的跨模块 ready 链，排除；
- **按频率分级**（低频允许组合、高频必须寄存）：判据含工艺/约束参数，机器判定复杂且
  易漂移，排除。
