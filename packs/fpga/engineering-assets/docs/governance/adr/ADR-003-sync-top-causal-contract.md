---
adr_number: 'ADR-003'
title: 'sync_top 因果化输出契约、符号量化相关器与无反压前端'
date: '2026-08-01'
status: 'accepted'
supersedes: ''
superseded_by: ''
deciders: ['lihan']
stakeholders: ['owner (lihan)', 'models/comm/synch 维护', 'sync_top RTL', '下游 FFT/channel_est_top']
tags: ['synchronization', 'ofdm', 'cfo', 'golden-model', 'architecture']
---

# ADR-003: sync_top 因果化输出契约、符号量化相关器与无反压前端

**Date**: 2026-08-01
**Status**: accepted（三项均采推荐方案; deciders: lihan）

## Context

`models/comm/synch` 已 L1/L2 绿（`run_all_tests` 5/5，向量同 seed 双跑
bit-identical），可作 `sync_top` 正确性锚。但推进 certified 时暴露三个
契约级空洞：

1. **golden 期望是离线批改**：`run_synch_sim` 用最终粗 CFO 估计对**整段**
   接收流（含估计完成之前的样点）回溯旋转后导出 `expected_sync_out.bin`。
   因果流式 RTL 原理上做不到——估计存在之前的样点无法用它校正。
2. **精定时相关器资源**：64 抽头全精度并行复相关 ≈200+ DSP，远超预算；
   且 T1 系数表按 MODEL-STATUS §5 要求应由 golden 导出，不得 RTL 硬编码。
3. **反压语义缺失**（RTL F7）：`m_axis_tready` 未使用，下游拒收丢样点，
   无任何契约文字。

## Decision

1. **m_axis 因果式校正**：粗 CFO 估计锁存后，从下一样点起 NCO 旋转校正
   （相位参考零于该点）；之前的样点走同一旋转流水但 θ=0（≈恒等，含
   CORDIC 量化抖动，保证全程延迟恒定）。`generate_vectors.m` 改造为
   RTL **位真镜像**（channel_est 同模式），旧离线批改语义作废。
2. **符号量化相关器**：T1 系数量化为 ±1（I/Q 各 1 bit），由 golden 导出
   系数表；乘法退化为加减法树，0 DSP 流式实现。定时精度在 TB 中对
   golden 全精度结果实测验收（目标 ±1 样点）。
3. **无反压前端契约**：同步前端是实时采样流，有限缓冲无法吸收持续反压。
   契约化：稳态运行中 `m_axis_tready` 必须为高，瞬时拒收丢样点属上游
   集成责任；写入 limitations 与 manifest。需要弹性的集成方在下游自接
   已认证的 `axis_skid_buffer`。

配套契约（实施推导，随实现固化到 manifest/README）：

- 精 CFO（T1/T2 相位差）不在 RTL 范围——golden 导出向量即用粗校正流,
  与 §1 因果语义一致。
- `o_fft_start` 与 m_axis 上的 T1 首样点**对拍对齐**：数据通路内置固定
  深度延迟线（≥ 峰值确认最大滞后），锁定后按 (决策拍 − 峰值位置) 反推
  对齐脉冲。`o_sync_locked` 置位后保持到复位（单突发语义，记录为限制）。
- 向量长度：前导码后追加随机 QPSK-OFDM 数据符号，使总长 ≥2048
  （G-B-03 下限；MODEL-STATUS §4 未决项就此裁决为"加数据符号"）。

## Consequences

- 正面：全链因果可综合；0 DSP 相关器；延迟恒定；向量契约可 0 容差判卷。
- 代价：估计锁存前的样点未校正（下游 FFT 窗之后全在校正段内，无感）；
  直通段有 CORDIC 量化抖动（±数 LSB）；符号量化相关器峰值信噪比略降
  （TB 实测验收兜底）；数据通路多一条 ~384 深延迟线（≈1 RAMB18）。

## Alternatives Considered

- **缓冲重放**（对齐 golden 批改语义）：数 KB 缓存 + 数百拍突发延迟 +
  吞吐断流，实时接收链不可用，未采纳。
- **全精度时分复用相关器**：精度与 golden 一致，但需缓存+慢搜索，
  fft_start 时序契约大幅后移，与缓冲重放同病，未采纳。
- **内置 skid 缓冲**：只能吸收单拍气泡，持续反压仍丢样点（物理必然），
  换来延迟+契约复杂度，未采纳；弹性需求由库内 axis_skid_buffer 下游解决。
