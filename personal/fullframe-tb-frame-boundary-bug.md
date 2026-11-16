---
name: fullframe-tb-frame-boundary-bug
description: 全帧2569字节PSDU TB — deinterleaver tlast导致viterbi r_frame_bits=1
metadata:
  type: project
---

全帧 TB (`tb_rx_demod_path.sv`) 的 PSDU 2569 字节端到端验证失败，根源在于：
- viterbi 输出 23142 字节（应 ≈2571），其中 20608 字节 `last=1`
- 根因：`r_dp_last` 在首对 deinterleaver nibble 就触发 → viterbi `!r_started` 分支设 `r_frame_bits <= 16'd1`（`i_cfg_is_signal=0`）
- 每字节输出时 `r_bits_out + 1 >= 1` 恒成立 → 每字节 `tlast=1`

这导致 viterbi 的 flush_pend 路径不断触发，每次输出 1 字节。

**与反压无关**：原始代码（git stash）也产生完全相同的 VIT=23142 和 DS=23142 bytes。

**已修复**：
- `rx_fifo.sv`: `s_axis_tready=1'b1` → `!bank_dirty[wr_bank]` 防乒乓溢出 ← standalone TB 验证通过
- `tb_rx_demod_path.sv`: `write_symbol_block` 加 `s_axis_tready` 检查 + 主循环用 `eq_ready` 反压

**未解决**：
- deinterleaver 的多符号帧边界 tlast 传播错误 → viterbi `r_dp_last` 过早触发
- phase_comp 仍被旁路

**Why:** deinterleaver 输出 tlast 在第一个 nibble 就为 1，导致 viterbi 认为帧只有 1 个 nibble（1 bit）
**How to apply:** 需要排查 deinterleaver 的帧长度跟踪逻辑，看它如何根据 `s_axis_tlast` 决定 `m_axis_tlast`
