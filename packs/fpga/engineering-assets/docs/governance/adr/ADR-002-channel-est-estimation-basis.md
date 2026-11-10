---
adr_number: 'ADR-002'
title: 'channel_est 估计基础: 长训练符号 LS + 导频相位跟踪'
date: '2026-07-31'
status: 'accepted'
supersedes: ''
superseded_by: ''
deciders: ['lihan']
stakeholders: ['owner (lihan)', 'models/comm/channel_est 维护', 'channel_est_top RTL']
tags: ['channel-estimation', 'ofdm', 'golden-model', 'architecture']
---

# ADR-002: channel_est 估计基础 — 长训练符号 LS + 导频相位跟踪

**Date**: 2026-07-31
**Status**: accepted（裁决: 方案 1; deciders: lihan）

## Context

`models/comm/channel_est/MODEL-STATUS.md`（2026-07-26, MATLAB R2022a 实跑）记录了
规格与测试的直接矛盾：测试信道时延扩展 16 抽头 → 相干带宽约 4 个子载波，而导频
{-21,-7,7,21} 间隔 14 个子载波——**违反信道频域采样定理**，任何插值方法都无法从
4 个欠采样点重建 16 抽头信道。实测：4 导频+线性插值 MSE **-1.88 dB**（门限 -10 dB
不可达）；长训练符号全 52 用载波 LS **-18.28 dB**（可达）。
`run_all_tests` 1/5 PASS，阻塞不是代码缺陷而是前提不成立。

## Decision

**采纳方案 1：长训练符号 LS。** 初始信道估计改用长训练符号（全部 52 个用载波）做
LS，4 个导频只用于后续残余相位跟踪——802.11a 的真实做法，实测可达 -18.28 dB。

实施顺序（golden 先行，fail-closed）：

1. `algorithm_spec.md` 修订估计基础章节（长训练符号结构、全载波 LS、导频相位跟踪）；
2. golden .m 实现 + 测试改造 → `run_all_tests` 5/5；保护带三方不一致
   （ls_channel_est.m:36 vs config.m:19 vs spec:88）在改造中一并修；
3. `channel_est_top` RTL 架构按新估计基础重排（MODEL-STATUS §5 的 32 条缺陷合并
   处理），接口/资源预算重估；manifest.params 的 N_PILOT rationale 同步更新。

MODEL-STATUS.md 的状态行更新待 golden 改造启动时随首个提交一并做
（models/ 树受黄金模型文件保护，需逐文件批准，本 ADR 先行承载裁决记录）。

## Consequences

- 正面：测试门限 -10 dB 无需放宽（实测 -18.28 dB 有 8 dB 裕量）；与 802.11a
  工程实践一致；spec 的多径场景描述保留。
- 代价：`channel_est_top` 架构、接口（需接收长训练符号窗口）与资源预算重排；
  golden 与 vectors 全部重做；该包 certified 排期后移至 golden 5/5 之后。

## Alternatives Considered

- **方案 2 收窄信道模型**（delay_profiles ≤4 抽头满足采样定理）：验收信道变弱，
  与 spec 多径场景描述不符，未采纳。
- **方案 3 放宽 MSE 门限**：判据迁就结果，违反 `docs/rules/03-gates.md`，明确排除。
