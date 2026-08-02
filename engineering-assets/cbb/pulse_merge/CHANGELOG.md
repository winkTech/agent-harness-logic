# Changelog

## [1.0.2] — 2026-08-02 证据重建：从"不可复现"到可复现

本包此前是全库仅剩的两个证据不可复现资产之一。已安装的 `alignment-report.json`
出自一套"ModelSim 轨迹 vs Python 模型"的外部 replay harness，而**那套 harness
在仓库里不存在**；证据里记的 golden 路径
`engineering-assets/incubator/qualification/pulse_merge/model/*.py` 也已随
incubator 清空而失效（模型本身还在，迁到了 `models/comm/pulse_merge/`）。

新增 `tools/run-model-backed-sim.sh`，**按原命令日志路径重建**——那些命令就写在
`reset-sim.json` / `stability/*.json` 里，照抄即可：

- Python 参考模型单测 `python -m unittest -q test_pulse_merge_model.py`：3/3 OK
- iverilog/vvp 两组参数：`INPUT_WIDTH=4 COUNT_WIDTH=12` 与 `INPUT_WIDTH=2 COUNT_WIDTH=4`，均 PASS
- 2600 拍对标规模运行：PASS（TB 内联逐拍参考实现与 DUT 逐拍比对，任一不符即 `$fatal`）

**一处如实降级**：`alignment-report.json` 原有的 `vector_sha256` /
`trace_sha256` 两个字段**已去掉**——它们来自那套已消失 harness 的轨迹转储，
无法复算。证据因此略弱于原版，但**可被任何人重新生成**；一份谁也重做不了的
强证据，价值低于一份能重做的稍弱证据。变更已写进该文件的 `basis_note`。

`reset-sim.json` 里的 `cwd` 也由失效的 `incubator/qualification/...` 更正为
`models/comm/pulse_merge`。RTL、约束、TB 零改动。

## [1.0.1] — 2026-08-02 声明证据复现入口（G-GATE-02）

manifest 新增 `reproduce` 字段，把"证据怎么重做"从 README 里的散文变成**机器可校验
的契约**。新门 `G-GATE-02` 校验该命令引用的脚本在仓库中真实存在。

动因：`G-GATE-01` 只查证据文件在不在，普查发现 16 个 certified 里 14 个的证据当时
无法被任何人重新生成，**却全都通过了 G-GATE-01**。

RTL、约束、TB、证据零改动；升 patch 版仅因 manifest 内容变化会使快照的
`manifest_sha256` 失配，按库内既定做法升版重取。

## [1.0.0] - 2026-08-02

RTL、约束、TB 与全部功能结论自 0.4.0 起未做任何改动。本版做两件事：

- **上游 commit 反查并钉定** —— `provenance.commit` 从 `null` 变为
  `25156a9a162c41c60f11f41590c7d006d015ae5a`（2024-04-26，"Add example design for
  Alveo U55C"）。0.4.0 的说法是"归档无 `.git` 元数据，故 commit SHA 不可复原"，
  **这个说法是错的**：无 `.git` 只说明元数据丢了，而 git blob SHA 是内容的函数，
  内容俱在就能反查。
  - 方法：对候选 commit 拉递归树，逐路径比对 `reference-assets/vendor/verilog-pcie-master/`
    的 633 个文件。
  - 结果：路径集完全一致（仅本地 0 / 仅上游 0）；blob 分类为**逐字节一致 4 +
    仅 CRLF 差异 545 + 上游 symlink 在 Windows 解压落成空文件 84**（上游 symlink
    总数正是 84），**未解释的差异 0**。
  - 排他性：相邻 commit 均不满足 —— `195be74a` 及更早还没有 AU55C 那批文件。
  - 本模块直接来源 `rtl/pulse_merge.v` 单独复核：上游 blob `aafe38a8` 等于本地文件
    LF 归一后的 blob。
  - registry ITG-0013 的 `upstream-commit-unpinned` 据此关闭。
- **版本号转正 1.0.0**（owner 2026-08-02 裁定）—— 资产自 2026-07-27 起就是 certified，
  但版本号一直停在 0.4.0，与库内其余 certified 资产不一致。
  `evidence_ref` / `evidence_snapshot_ref` 指向 `evidence/pulse_merge/1.0.0/`，
  0.4.0 快照原封转为历史。

## [0.4.0] - 2026-07-27

- Owner signoff completed and the foundation asset was admitted to `cbb/` with bit-true, ModelSim, Vivado and CDC evidence; board/field validation and upstream commit pinning remain outside the release scope.

## [0.3.8] - 2026-07-27

- Corrected the reset-boundary waiver in the reusable SVA, then passed ModelSim 10.6c assertion-instance execution and 2600-sample bit-true Golden alignment (mismatch=0).

## [0.3.7] - 2026-07-26

- Recorded real Vivado 2023.1.1 synthesis, utilization, timing, clocks, and post-synthesis checkpoint evidence for `xc7a35tcpg236-1`; certified promotion remains blocked by bit-true/signoff gates.

## [0.3.6] - 2026-07-26

- Sealed the refreshed manifest hashes after recipe generation; 0.3.5 remains an immutable historical evidence envelope.

## [0.3.5] - 2026-07-26

- Refreshed manifest source hashes after the deterministic EDA recipe update; 0.3.4 remains an immutable historical evidence envelope.

## [0.3.4] - 2026-07-26

- Fixed official Vivado batch launch for workers missing `PROCESSOR_ARCHITECTURE` and preserved hidden `.codex` worktree paths in the certification Tcl recipe. ModelSim SVA is green; Vivado synthesis remains blocked by the genuine device-license checkout result.

## [0.3.3] - 2026-07-26

- Kept ModelSim work libraries in the temporary EDA build root and added the
  Vivado-generated `synth-meta.json` artifact contract.

## [0.3.2] - 2026-07-26

- Hardened external EDA scripts to resolve package paths from the script
  location and removed the invalid Vivado self-as-XDC read.

## [0.3.1] - 2026-07-26

- Reissued the qualification snapshot after real EDA collection; the prior
  0.3.0 snapshot remains immutable historical evidence.

## [0.3.0] - 2026-07-26

- Added 100 MHz create_clock constraint, resource budget envelope, and local
  reset/stability evidence for the certification gates.
- External timing/utilization, bit-true cosim, and signoff remain blocked until
  genuine EDA execution is available.

## [0.2.0] - 2026-07-26

- Added deterministic extraction-pipeline intake/provenance and external EDA
  certification recipes with fail-closed ModelSim/Vivado/CDC evidence.
- Retained immutable 0.1.0 evidence; 0.2.0 records the real ModelSim license
  exit 4 and missing Vivado probe without a certified claim.

## [0.1.0] - 2026-07-26

- Added normalized pulse-credit merger derived from the MIT vendor reference.
- Added independent Python model, SVA, bounded random/reset TB, and provenance
  license records.
- Qualified local compile/simulation paths without claiming upstream commit
  reproducibility or certified EDA closure.
