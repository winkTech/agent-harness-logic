---
name: viterbi-double-traceback-fix
description: viterbi DONE→IDLE 跨 block NBA 竞态导致 28 traceback(应为14), 加 r_tb_pending_clear 修复
metadata:
  type: project
---

## 问题
viterbi 在 `tb_rx_demod_path` 全帧仿真中产生 28 次 traceback (应为 14)，导致 VIT 输出 23142 字节 (应为 ~2571)。

## 根因
跨 block NBA 时序竞态：
- **Block A** (ACS, line 245): `r_reinit` 触发时在同一周期通过 NBA 清除 `r_acs_done/r_started/r_acs_cnt`
- **Block B** (TB FSM, line 326): DONE→IDLE 转换后，IDLE check 读取 Block A 的清除前旧值 → 误触发第二次 traceback

## 修复
在 `viterbi.sv` 的 TB FSM block 中添加 `r_tb_pending_clear` 寄存器：
- DONE→IDLE 转换时置 1
- `r_dp_valid` 到达时清 0 (新 nibble pair 开始 ACS)
- IDLE traceback 条件加 `!r_tb_pending_clear` 门控

## 效果
- traceback: 28 → 14 ✅
- VIT: 23142 → 2562 bytes (帧边界完全正确)
- 剩余 2553/2569 数据错误为预存 PN 极性偏移问题，与 traceback 无关

**Why:** 跨 block 读取寄存器时，同一时钟沿的 NBA 更新在不同 block 间有不可预测的顺序。
**How to apply:** 任何跨 block 的"条件→清除"模式都可能出现类似竞态。用同一 block 内的标志位做门控。
