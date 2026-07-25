# engineering-assets — FPGA 工程资产库（嵌入 harness 仓库）

> 一个"防止设计偏离需求"的设计支撑库。三个资产域各是设计流程里的一个锚：
> **文档=方向锚 · MATLAB Golden=正确性锚 · CBB=实现锚**。
> 反偏离锚链：`需求 → 文档 → golden model → CBB`，CBB 与 golden bit-true 对齐。

## 目录

| 目录 | 内容 |
|---|---|
| `cbb/` | **仅认证通过**的 RTL CBB |
| `models/` | **仅认证通过**的 MATLAB 模型 |
| `knowledge/` | 领域知识/方法论/索引（迁自 `~/.claude/knowledge/`） |
| `incubator/{intake,qualification}` | 孵化中、未认证资产 |
| `reference-assets/vendor/` | 第三方完整工程（仅参考，不认证） |
| `schemas/` | `cbb-manifest.schema.json` 等 |
| `tools/` | `gate-runner.cjs` 门禁 runner |
| `docs/governance/` | 《CBB 治理与生产级准入规范 V1.0》 |
| `var/gates/pg/<uid>/` | 门禁证据（生成物，已 gitignore） |

## 生产级准入门（MVP）

治理规范见 `docs/governance/CBB-治理与生产级准入规范-V1.0.md`。
一个资产要进 `cbb/`，须过 §2 的 A/B/C 三维硬门 + 无项目专用硬编码 + 具名签字。

跑门禁：

```bash
node engineering-assets/tools/gate-runner.cjs <asset-package-dir>
# 例: node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/qualification/rrc_polyphase_fir
```

- 机器门（schema/sha256/命名/复位红线/输出寄存/initial/尺寸/锚链）+ iverilog lint 即时判定；
- tool 类门（Vivado STA/util、bit-true cosim）未接线时标 **blocked**，绝不静默放行；
- runner 计算资产实际达到的成熟度级并列出阻塞门。退出码 0=达 certified 资格，1=未认证。

## 状态

MVP 工具切片就绪，首个试点 `rrc_polyphase_fir` 已跑通（当前卡在 intake：命名红线）。
scale-up 项（ajv 实例校验、Vivado/CDC 门、bit-true cosim、catalog 派生+drift、不透明 uid）按规范 §7.2 触发条件再上。
