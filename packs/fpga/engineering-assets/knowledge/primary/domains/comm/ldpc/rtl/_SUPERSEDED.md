---
name: ldpc-rtl-superseded
description: LDPC 旧 RTL/TB 的已知架构缺陷、禁用边界与权威替代路径
metadata:
  type: reference
  domain: comm
tags: [ldpc, rtl, deprecated, safety, verification]
related: [ldpc-codec]
---

# ⛔ SUPERSEDED — 本目录 RTL/TB 已被取代,禁止引用

> 标记日期: 2026-07-27。

本目录(`01_rtl/`、`02_sim/`)是 ldpc 译码器**修复前的旧版副本**,已实测存在
架构级缺陷,**任何新工程不得引用、复制或例化这里的文件**:

- 控制器缺写回相位(PASS2 无消费者),msg 寻址越界读 X —— 10 组黄金向量
  全部失败(324/324 bit 错),证据见
  `incubator/intake/ldpc_codec/ARCHITECTURE-GAP.md`
- `02_sim/tb_ldpc_decoder_top.v` 是**假绿历史版本**:向量路径截断导致
  `$readmemh` 静默失败、空对空比对报 PASS(commit `10b9901` 修复)

## 权威版本

`engineering-assets/incubator/intake/ldpc_codec/`
— QUALIFICATION 级,bit-true 10 向量 3240 样点 0 失配,17/18 门绿。

## 为什么不直接删除

knowledge 树对本目录存在多处引用(盘点约 44 处,含可执行相对路径
`channel_est/run_rtl_cosim.m`),删除属去重任务,须先迁移引用再删
(见治理项目记忆"去重"条目)。在此之前以本横幅 + 各文件头部标记防误用。
