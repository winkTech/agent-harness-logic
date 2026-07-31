# engineering-assets — FPGA 工程资产库（嵌入 harness 仓库）

> 一个"防止设计偏离需求"的设计支撑库。三个资产域各是设计流程里的一个锚：
> **文档=方向锚 · MATLAB Golden=正确性锚 · CBB=实现锚**。
> 反偏离锚链：`需求 → 文档 → golden model → CBB`，CBB 与 golden bit-true 对齐。

## 目录

| 目录 | 内容 |
|---|---|
| `cbb/` | **仅认证通过**的 RTL CBB |
| `models/` | **仅认证通过**的 MATLAB 模型 |
| `knowledge/` | 领域知识/方法论/索引（已自 `~/.claude/knowledge/` 迁入） |
| `incubator/{intake,qualification}` | 孵化中、未认证资产 |
| `reference-assets/vendor/` | 第三方完整工程（仅参考，不认证） |
| `schemas/` | `cbb-manifest.schema.json` 等 |
| `tools/` | `gate-runner.cjs` 门禁 runner · `pg-synth.{cjs,tcl}` Vivado 证据生成 |
| `docs/governance/` | 《CBB 治理与生产级准入规范 V1.0》 |
| `var/gates/pg/<uid>/` | 门禁证据（生成物，已 gitignore） |

## 生产级准入门（MVP）

治理规范见 `docs/governance/CBB-治理与生产级准入规范-V1.0.md`。
一个资产要进 `cbb/`，须过 §2 的 A/B/C 三维硬门 + 无项目专用硬编码 + 具名签字。

跑门禁：

```bash
cd engineering-assets
node tools/pg-synth.cjs   <asset-package-dir>              # 生成 Vivado 时序/资源证据
node tools/gate-runner.cjs <asset-package-dir> --repo-root ..
```

- 机器门（schema/sha256/命名/复位红线/输出寄存/initial/尺寸/锚链）+ `vlog` lint 即时判定；
- tool 类门已接线：`G-C-01` 目标 fmax 收敛、`G-C-02` 资源包络（fail-closed）、
  `G-C-03` 由 Vivado 日志裁决 `initial` 是否被综合器忽略、`G-B-03` bit-true cosim；
- 仍未接线的门标 **blocked**，绝不静默放行；
- runner 计算资产实际达到的成熟度级并列出阻塞门。退出码 0=达 certified 资格，1=未认证。

## 参考样板

**`cbb/rrc_polyphase_fir/`** 是库内首个 certified 资产，也是 CBB 参考样板：
18 道 MUST 门全绿，其 `README.md` 演示了一个生产级资产
应当交付什么 —— 数值契约、准确接口、**实测**时序/资源包络、验证证据及其边界、
三条命令的证据复现、以及明确列出的已知限制。新建资产建议照该结构组织。

## 状态

工具切片就绪并已在 Vivado 2023.1 + ModelSim 上跑通。当前各包达到级别：

<!-- BEGIN:CATALOG:STATUS -->
| 资产 | 声明级别 | 机器达到级别 | 阻塞门 |
|---|---|---|---|
| `axis_skid_buffer` | qualification | qualification | certified |
| `cdc_sync` | qualification | qualification | certified |
| `channel_est_top` | intake | qualification | certified |
| `complex_multiplier` | qualification | qualification | certified |
| `crc32` | qualification | qualification | certified |
| `ddr_axi4_controller` | qualification | qualification | certified |
| `delay_line` | qualification | qualification | certified |
| `frame_sync` | qualification | qualification | certified |
| `ldpc_codec` | certified | certified | — |
| `lfsr_gen` | qualification | qualification | certified |
| `model_comm_channel_est` | intake | — | no gate-results |
| `model_comm_ldpc` | intake | — | no gate-results |
| `model_comm_ofdm` | intake | — | no gate-results |
| `model_comm_rrc` | qualification | — | no gate-results |
| `model_comm_synch` | intake | — | no gate-results |
| `ofdm_tx_top` | intake | qualification | certified |
| `pulse_merge` | certified | certified | — |
| `pulse_merge_golden` | qualification | — | no gate-results |
| `rrc_polyphase_fir` | certified | certified | — |
| `sdp_ram` | qualification | qualification | certified |
| `stream_elastic_pipeline` | certified | certified | — |
| `stream_elastic_pipeline_golden` | qualification | — | no gate-results |
| `sync_top` | intake | qualification | certified |
<!-- END:CATALOG:STATUS -->

> 2026-07-28：以上四个包完成 hdl-coding 五条红线整改，**红线类门（`G-A-00`
> 编译 / `G-A-01` 同步复位 / `G-A-02` 命名 / `G-A-04` 尺寸 / `G-C-03` initial /
> `RL-OUT` 输出寄存）全部转绿**，三个 reference 级包因此升至 qualification。
> 余下阻塞项全是"缺 Vivado 报告 / 缺 golden 向量 / 缺签字"，不再有代码层违规。
> 各包的接口与延迟契约变化、以及整改中发现的功能缺陷，见各包 `CHANGELOG.md`。


### Foundation CBB admissions (v0.4.0)
- `cbb/stream_elastic_pipeline`: certified; ModelSim/Golden/Vivado evidence on generic target `xc7a35tcpg236-1`.
- `cbb/pulse_merge`: certified; ModelSim/Golden/Vivado evidence on generic target `xc7a35tcpg236-1`.
- G-SIGN-01 owner signoff is recorded; board/field/routed/bitstream validation remains outside this admission.

scale-up 项（ajv 实例校验、CDC 门、catalog 派生+drift、不透明 uid）按规范 §7.2 触发条件再上。
