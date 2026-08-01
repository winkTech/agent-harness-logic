# CHANGELOG — rrc_polyphase_fir

> 回填于 2026-07-31（P2 既定任务）：素材 = git 历史 + README §10 修复史。

## [1.0.0] — 2026-08-02 版本号转正（owner 裁定）

资产自 2026-07-25 起就是 certified 且 18 门全绿，但 `version` 一直停在 `0.4.0`，
与库内其余 certified 资产（均已 1.0.0）不一致 —— 引用方按版本号推断成熟度会读错。
本次由 owner 裁定转正。

**RTL、约束、TB 与全部功能结论自 0.4.0 起未做任何改动**，转正的依据是本次补齐的
布线后时序证据与哈希锁定快照（见下方同日条目）。相应地：

- `maturity.evidence_ref` → `evidence/rrc_polyphase_fir/1.0.0/`，
  0.4.0 快照原封转为历史。
- `signoff.at` 更新为 2026-08-02，并**改掉一条已被实测证伪的签署措辞** ——
  原写"已接受限制：综合级 hold 未收敛，上板前须以实现后时序为准"，
  实测证明它不会自行收敛（WHS 四阶段恒定），故改为如实陈述违例、归因与
  量化关闭条件。签署所接受的限制同时补上"setup 裕量薄"、"未上板"、
  "ModelSim 复现路径当前不可用"三条 —— 它们此前只在文档里，没进签署范围。

## [0.4.0] — 2026-08-02 补证据（RTL / 约束零改动）

RTL、约束、TB 与全部功能结论未变；本次只补证据与修正被证伪的文档陈述。

- **补齐布线后时序证据**：实跑 OOC synth→opt→place→route（Vivado 2023.1.1），
  产出 `hold-closure.json` / `route-timing-summary.rpt` / `route-utilization.rpt` /
  `route-drc.rpt`。结论：setup 布线后 WNS **+0.058 ns**（0/2713 失败）；
  hold **WHS 四阶段恒为 −0.163 ns**，布线后 320/2713 端点失败。
  - **证伪了 README §4 原先的说法**（"综合级 hold 是估算值、正常在布局布线阶段
    收敛"）。该违例根本不受布局布线影响。
  - 归因：924 条违例路径**全部从输入端口出发、内部单元起点 0 条**；
    reg-to-reg 最差 hold **+0.094 ns**，内部时序已收敛。唯一失败端口是 `i_rst`
    （`i_rst → addA_i_reg[0]/RSTM` 这个 DSP48E1 复位脚，其 hold 需求 0.201 ns
    远大于普通 FF），由 XDC 那个自称"显式假设、非实测"的
    `set_input_delay -min 0.100` 支配。量化关闭条件：真实最小输入延时 ≥ 0.263 ns。
  - registry ITG-0009 的 `hold-closure` **仍不关闭**（确有违例，如实记录不豁免），
    但状态从"未知"推进到"单一端口、单一成因、有量化关闭条件"。
- **补齐哈希锁定证据快照**：本资产此前是库内 certified 中**唯一**
  `maturity.evidence_ref` 指向可再生实时目录 `var/gates/pg/` 的资产，
  `evidence-snapshot --verify-all` 覆盖不到它。现取 `evidence/rrc_polyphase_fir/0.4.0/`
  快照并把 `evidence_ref` 指过去，全库 `--verify-all` 从 16 升到 **17 verified**。
- **清理证据目录边界**：把混在里面的两份工作产物
  （`implementation-diagnostic/`、`stoploss-validation-20260726-140818/`）
  挪到 `var/impl/rrc_polyphase_fir/legacy-artifacts/`。它们不是证据，
  留在快照源目录会让快照边界失去意义（`evidence-snapshot` 也正是因此拒绝取快照）。
- 新增 `docs/limitations.md`（12 条）；README §7 改为指向该文件只留摘要。

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
