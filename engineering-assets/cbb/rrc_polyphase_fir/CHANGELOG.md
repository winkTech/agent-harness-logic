# CHANGELOG — rrc_polyphase_fir

> 回填于 2026-07-31（P2 既定任务）：素材 = git 历史 + README §10 修复史。

## [0.4.0] — 2026-07-25 certified（提交 dacefb7）

- **流控修复**：原 `s_axis_tready` 恒 1 且 `m_axis_tready` 不参与节流（两侧无流控，
  G-C-05 背压子结果无法通过）。补入口 ready 与出口停顿门控；TB cosim 驱动循环
  同步改为按握手推进（原固定节拍驱动在背压下会静默丢符号，实测 2048/2048 全失配
  暴露）。背压下复测 0/2048 失配。
- signoff（owner: lihan, 2026-07-25）+ maturity certified；G-C-01/02 综合证据齐备
  （WNS +0.252 ns；已接受限制见 manifest.signoff.scope，含 DSP 零裕量 24/24 与
  综合级 hold 未收敛 −0.163 ns）。

## [0.3.0] — 2026-07-25 qualification，bit-true 达成

- **数值修复**：原系数表与 golden `rrc_coeff.hex` 不符，且相 1–3 的"对称折叠"数学
  上不成立（33 抽头 RRC 仅相 0 自对称）。重写为 9 抽头/相直算 + golden 系数 +
  round-half-away(/2^15) + 对称裁剪 ±32767，与 golden 定点语义精确一致。
  cosim 2048 样点 0 失配（流水偏移 16 = 4 符号群延迟）。
- **时序修复**：单拍 9 项连加被综合成 7 级 DSP48 PCOUT 级联（≈11 ns，WNS −6.211）。
  改 3 级寄存加法树后瓶颈转移至 round_clip（19 逻辑级），再拆两级，最终 WNS +0.252 ns。
  延迟 4 拍 → 7 拍；ACC_W=38 全精度无截断，输出逐位不变（cosim 复测佐证）。
- 关联发现：golden 向量导出损坏（expected_tx 全常量），原件归档
  `vectors/expected_tx.broken-orig.hex`，以 `models/comm/rrc/tools/regen-vectors.cjs`
  忠实复算再生（golden .m 未动，建议 MATLAB 原生复核）。

## [0.1.0] — 2026-07-25 intake（提交 4efbf94，第一批入库）

- 自既有 RRC 多相 FIR 工程打包：rtl + tb + manifest；走通首版准入门禁
  （schema/lint/命名/红线扫描）。
