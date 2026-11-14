# core — 宿主无关引擎

`core/engine` 是 harness 的引擎层：事件归一、门禁路由、验证循环、记忆存储、遥测与 loop 控制。它不包含任何宿主词（C-1 扫描守护）与域内容（FPGA 全在 `packs/fpga`）。

## 结构

```
core/engine/
  hooks/          manifest v3 + 各事件族入口（router/observer/loop/guards）
  scripts/        引擎脚本：渲染器/同步器/bench/测试/test-hooks
  scripts/transport/  四方言载荷归一（claude-code/workbuddy/codex/grok）
  scripts/lib/    host-concepts（方言唯一事实源）/ harness-state / pack-config / env 翻译
  scripts/io/     归一化载荷/三通道编码/遥测 spool
  sqlite/         事件/成本/图/记忆存储（node:sqlite，零依赖）
  schemas/        harness-event-v1 + claude-hook payload 契约
  io/schemas/     per-event payload schema 实例
core/rules/       通用规则真源（宿主无关：gates/git/harness）
```

## 关键合同

| 合同 | 文件 | 要点 |
|---|---|---|
| 事件契约 | `schemas/harness-event-v1.schema.json` | status 三值（绝不臆测成功）；eventType 中性名 |
| 注册契约 | `hooks/manifest.json` | v3：entries(transports/hostOnly/timeoutOverrides) + hostPresets + consumerRegistry |
| 方言契约 | `scripts/lib/host-concepts.cjs` | 事件名/matcher 翻译/工具别名唯一事实源 |
| 纯度契约 | `scripts/layer-boundary.cjs` | core 无 packs 路径/无宿主拓扑词/无 env 泄漏 |
| 遥测契约 | `scripts/io/telemetry-spool.cjs` + `spool-drain-lib.cjs` | 亚毫秒落盘；消费者五件套（声明/调度/水位/心跳/有界） |

## 修改守则

- 改 manifest：跑 `hook-manifest-contract.cjs`；渲染器消费的声明字段只增不改。
- 改引擎脚本：全量回归 `run-all-tests.cjs --no-persist`（基线 4 项行为级失败为已知）。
- 改规则表（packs 域）：改 `packs/*/config/*.json`，勿在 core 写域词。
- 新增 hook：manifest 注册 + 对应宿主渲染器真源同步 + 合同测试。

## 零依赖

引擎只用 Node 内建（含 `node:sqlite`）。无 npm 依赖、无外网调用。Windows 优先（路径 <260 注意）。
