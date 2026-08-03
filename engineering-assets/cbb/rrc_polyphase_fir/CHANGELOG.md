# CHANGELOG — rrc_polyphase_fir

> 回填于 2026-07-31（P2 既定任务）：素材 = git 历史 + README §10 修复史。

## [1.0.2] — 2026-08-02 声明证据复现入口（G-GATE-02）

manifest 新增 `reproduce` 字段，把"证据怎么重做"从 README 里的散文变成**机器可校验
的契约**。新门 `G-GATE-02` 校验该命令引用的脚本在仓库中真实存在。

动因：`G-GATE-01` 只查证据文件在不在，普查发现 16 个 certified 里 14 个的证据当时
无法被任何人重新生成，**却全都通过了 G-GATE-01**。

RTL、约束、TB、证据零改动；升 patch 版仅因 manifest 内容变化会使快照的
`manifest_sha256` 失配，按库内既定做法升版重取。

## [1.0.1] — 2026-08-02 补 xsim 双通路；证伪一个 hold 修法

**RTL 逻辑未变**（仅新增一段"勿重复尝试"的注释）。

### 补 `run_xsim.sh` —— 复现路径重新可用

本机 ModelSim 回环 RPC 自 2026-08-01 起故障，`run.do` 那条路跑不通，等于本资产的
仿真证据无法复现。现补 Vivado xsim 2023.1.1 通路，**两条共用同一份 TB、同一套判据**。

交叉验证：xsim 与 ModelSim 时代的六份证据（`alignment-report` / `reset-sim` /
`stability` 四项）**逐字节相同**，包括 `stall_cycles=820`、`symbols_accepted=516`、
`achieved=0.200311` 这些带随机性的数字（TB 用固定 seed）。

顺带修掉一处**错误署名**：证据的 `tool` 字段原先写死 `"ModelSim vsim"`，迁到 xsim
后会让证据声称自己出自一个并没有跑过它的仿真器。现由运行脚本注入 ——
ModelSim 走 `+TOOL` plusarg，xsim 走运行目录下的 `sim-tool.txt`
（xsim 的 `-testplusarg` 会在 `=` 处把参数切碎，传不了）。

### 证伪：`i_rst` 寄存一拍**不能**关掉 hold-closure

1.0.0 的记录里提出过一条修法——把 `i_rst` 在核内寄存一拍，让当时最差的
`i_rst → addA_i_reg[0]/RSTM`（DSP48E1 复位脚）变成 reg-to-reg。本版实测了它：

- 功能侧无回归：cosim `offset=16 mismatch=0/2048`、G-C-04 8/8、G-C-05 四项全过
- 时序侧**收益为负**：那条路径确实消失，但 **WHS 从 −0.163 ns 劣化到 −0.189 ns**。
  新的最差路径是 `s_axis_tdata[5] → sym_buf_i_reg[0][5]/D`，一个**普通 FDRE**，
  其 hold 需求 **0.227 ns 比 DSP48E1 RSTM 的 0.201 ns 还大**。

**根因**：问题从来不在 `i_rst`，而在 XDC 的 `set_input_delay -min 0.100` 这个占位
假设对所有输入一视同仁地过小。任何输入端口最终都要落进某个触发器，而
`sym_buf_i_reg[0]` 本身就已经是输入寄存级 —— **没有任何 RTL 变换能消掉输入端口的
hold 路径**，只能把它从一个端口挪到另一个端口。

因此改动已**回退**（不为零收益付"复位晚一拍"的行为契约变更），并在 RTL 里留下
一段说明防止重复尝试。`hold-closure` 据此重新归类为**不可由 RTL 关闭**，
与 `board-validation` 同属依赖集成/板级数据的阻塞项。

1.0.0 记录里"唯一失败端口是 `i_rst`"是**抽样不全导致的误判**——当时只抽查了
`s_axis_tvalid`（+0.218）与 `m_axis_tready`（+0.193），没抽查 `s_axis_tdata[*]`。

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
