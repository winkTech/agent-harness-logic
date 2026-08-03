---
adr_number: 'ADR-004'
title: 'ofdm_tx_top: 自研流水 IFFT、四调制全集与导频极性锚'
date: '2026-08-01'
status: 'accepted'
supersedes: ''
superseded_by: ''
deciders: ['lihan']
stakeholders: ['owner (lihan)', 'models/comm/ofdm 维护', 'ofdm_tx_top RTL', '下游信道/RX 链']
tags: ['ofdm', 'ifft', 'transmitter', 'golden-model', 'architecture']
---

# ADR-004: ofdm_tx_top — 自研流水 IFFT、四调制全集与导频极性锚

**Date**: 2026-08-01
**Status**: accepted（三项均采推荐方案; deciders: lihan）

## Context

golden 体检 (`model_comm_ofdm` 首次实跑): **run_all_tests 0/3**。根因两条机械
缺陷: G1 `tx_chain` 缺 reshape (mod_mapper 列向量被按 [N_data×N_sym] 消费,
10 符号帧只产出 1 个符号); G2 `test_boundary` 将 DC 写在第 33 位, 与
`ifft_chain` 头注释明文的自然序契约 (DC 在位置 1, 2026-06-03 修订) 矛盾。
RTL 侧 (`ofdm_tx_top` 0.1.0) 除 F1-F7 (cp_insert 乒乓未实现/计数器错/死状态、
64QAM 桩、配置端口未接) 外, 关键是 **F8: IFFT 是透传占位** (Xilinx FFT IP
行为壳, 不做变换、不可综合)——本包从未有过真正的 IFFT, 顶层输出结构上
不可能对标 golden。

## Decision

1. **自研流水 IFFT**: 64 点 R2²SDF 流水结构 (每拍一样点, 旋转因子 ROM,
   明确定义的逐级缩放调度), 全链可综合、可位真镜像、可 0 容差 cosim——
   与 channel_est_top/sync_top 同标准的库资产。透传占位 `tb/xfft_64.sv`
   随重排删除。
2. **四调制全集**: mapper 补 64QAM Gray 映射 (golden `mod_mapper` 已验证的
   映射表直接移植), 认证覆盖 BPSK/QPSK/16QAM/64QAM, 与 golden 能力对齐。
3. **导频极性以 golden 交替式为锚**: RTL 跟随 golden `subcarrier_map` 现行
   契约 (逐符号 ±1 交替, 首符号 +[1,1,1,-1])。802.11a 127 长 PRBS 扰码记为
   已知简化 (与 channel_est D6 同类目), golden 升级时两侧同步。

实施顺序 (golden 先行, fail-closed):

1. golden 修复 G1/G2 → `run_all_tests` 3/3; 建 MODEL-STATUS (首份, 记录
   0/3→3/3 证据链); manifest 版本+哈希。
2. `ofdm_tx_top` RTL 架构重排 (F1-F8 随旧通路整体消灭): mapper (四调制) →
   pilot/子载波映射 → R2²SDF IFFT → CP 插入; 定点契约 频域 Q2.14 →
   IFFT 逐级缩放 → 时域 Q3.13 (缩放调度随实现固化并写入镜像)。
3. `generate_vectors.m` 改 RTL 位真镜像 → cosim 0 容差 → 证据链 → 签字。

## Consequences

- 正面: 库内首个完整可综合 OFDM 发射机; IFFT 成为可复用一等构件;
  G-B-03 0 容差判卷与库治理标准一致。
- 代价: 本库迄今最大单包工作量 (IFFT 本体 + 位真镜像 + 全链验证);
  certified 排期后移至 golden 3/3 与 IFFT 实现之后。

## Alternatives Considered

- **Xilinx FFT IP 黑盒**: IP 定点行为难以 MATLAB 位真复现, G-B-03 只能
  容差判卷; pg-synth 流程需改造支持 xci; 库资产携带工具链依赖。未采纳。
- **降范围不含 IFFT**: 资产语义变弱, golden 对标切面碎化。未采纳。
- **64QAM 维持桩 / 三调制**: 与 golden 能力不对齐, 集成方踩桩静默出 0。未采纳。
- **两侧升 PRBS 扰码**: 波及已认证 channel_est 族固定导频假设, 范围大增。
  未采纳 (记为已知简化)。
