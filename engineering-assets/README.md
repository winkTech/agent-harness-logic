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

**`incubator/qualification/rrc_polyphase_fir/`** 是库内的 CBB 参考样板：
15 道 MUST 门中 14 道已过（仅余具名签字），其 `README.md` 演示了一个生产级资产
应当交付什么 —— 数值契约、准确接口、**实测**时序/资源包络、验证证据及其边界、
三条命令的证据复现、以及明确列出的已知限制。新建资产建议照该结构组织。

## 状态

工具切片就绪并已在 Vivado 2023.1 + ModelSim 上跑通。当前各包达到级别：

| 资产 | 达到级别 | 阻塞门 |
|---|---|---|
| `rrc_polyphase_fir` | qualification | `G-SIGN-01`（待签字） |
| `ldpc_codec` | qualification | `G-B-03`（译码器重写中，见包内 `ARCHITECTURE-GAP.md`）、`G-SIGN-01` |
| `ofdm_tx_top` / `channel_est_top` / `sync_top` | reference | `G-A-02` 命名红线（且均违反红线 3 复位极性，缺可用验证） |

scale-up 项（ajv 实例校验、CDC 门、catalog 派生+drift、不透明 uid）按规范 §7.2 触发条件再上。
