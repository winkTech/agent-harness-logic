# Agent Harness Logic

Runtime-neutral agent harness：一套门禁/验证循环/记忆与会话交接引擎，四个宿主（claude-code / workbuddy / codex / grok）同引擎、同判罚。

> **核心哲学**：可靠的系统承载不可靠的模型。让脚本做验证，让文件做证据，让 hook 做拦截——不让模型自报数据。

## 三十秒理解

```
宿主 (claude-code / workbuddy / codex / grok)
  │  hooks (各宿主注册面, 渲染零漂移)
  ▼
transport 层 ── 四方言载荷归一 (harness-event-v1)
  │
  ▼
core/engine ── 宿主无关引擎: 门禁路由 / 验证循环 / 记忆 / 遥测
  │              manifest v3 声明驱动 (transports / hostPresets / consumerRegistry)
  ▼
packs/ ──────── 域内容 (fpga: 规则/技能/工程资产/治理; office: 文档技能)
```

同一恶意样例（`hosts/tests/malicious-samples.jsonl`）经方言表翻译后过同一引擎，四路径判决 100% 一致（H-4 守护，`bench-refactor --phase 2`）。

## 分层职责

| 层 | 位置 | 职责 | 谁改它 |
|---|---|---|---|
| 宿主适配 | `hosts/<host>/` | 注册真源、渲染器、方言剖面、冒烟 | 接入新宿主时 |
| 引擎 | `core/engine/` | 门禁路由、事件归一、sqlite 存储、遥测 spool、loop 控制 | 引擎维护者 |
| 域包 | `packs/<domain>/` | 规则、技能、agents、工程资产、config 规则表 | 域贡献者 |
| 分发面 | `dist/plugin/` + 双 marketplace | `sync-plugin-dist.cjs` 组装的可再生产物 | 无人手改 |

## 安装矩阵

| 宿主 | 安装方式 | 验证 |
|---|---|---|
| claude-code | `render-hook-settings.cjs` 渲染 `~/.claude/settings.json` | `--check` 零漂移 |
| codex | `render-codex-hooks.cjs` 渲染 `~/.codex/hooks.json` + AGENTS.md | `--check` + trusted_hash |
| grok | `render-grok-hooks.cjs` 剖面投影 `~/.grok/hooks.json` | `--check` + smoke 8 检查 |
| workbuddy | `render-hook-settings.cjs` 同渲 `workbuddy.hooks.json` | `--check` |
| marketplace | `dist/plugin`（claude git-subdir / grok plugin_subdir） | `bench-d2-plugin-validate.cjs` |

**新机器接入**：对任意 coding agent 说"读 SETUP.md 和我一起装"——人只回答问题，agent 干活（<30 分钟，D-3 实测口径）。

## 质量门（CI 可复现）

```bash
node core/engine/scripts/harness-ci.cjs                 # 六段静态门禁
node core/engine/scripts/test-hooks/run-all-tests.cjs --no-persist   # 全量回归
node core/engine/scripts/bench-refactor.cjs --phase 2   # Phase 2+3 行为门
node core/engine/scripts/bench-refactor.cjs --phase 4   # 分发面门 (D-1/D-2)
```

关键指标：C-1 纯度=0 违规 · C-2 全量回归（基线 4 项行为级）· H-1 三宿主零漂移 · H-4 跨宿主等价 100% · P-4 packs 可卸性 · D-1 脱敏零命中。

## Hook 拓扑（契约面）

| 事件 | 引擎入口 |
|---|---|
| `UserPromptSubmit` | prompt-context.cjs：同进程合并规则 capsule、只读事实查询；实际注入另记 exposure |
| `PreToolUse` | preflight-router.cjs（进程内路由） |
| `PostToolUseFailure` | postflight-router.cjs（同步状态与失败记忆）+ postflight-observer.cjs（异步失败遥测/弱归因观察） |
| `SessionStart` | session-bootstrap.cjs（单进程恢复/Dream/isolation）+ 到期维护（async，仅 startup） |
| `Stop` | stop-summary.cjs（同步上下文/进度）+ postflight-observer.cjs（异步透明度/成本/Skill-Evolve） |

## 记忆治理入口

- 记忆/Dream/Hook 遥测/维护边界：`core/rules/05-harness.md`
- Dream 学习产出的是候选（candidate）——须人工批准（approval）后晋升为规则，无自主规则写入。
- 到期维护：`memory-knowledge-maintenance.cjs`（async 长钩子，grok 剖面由 spool 消费者调度）
- 规则晋升候选账本：`harness-rule-candidates.cjs`
- `memory-sqlite-sync.cjs` 处于 dormant（未注册）状态，不参与运行时。

## 目录速览

```
core/engine/          引擎（hooks/scripts/sqlite/schemas/transport/io）
core/rules/           通用规则真源（00-core/03-gates/04-git/05-harness——
                      记忆/Dream/Hook 遥测/维护/规则晋升边界见 core/rules/05-harness.md）
packs/fpga/           FPGA 域（skills/agents/rules/engineering-assets/config）
packs/office/         办公域技能（doc-gen/markitdown/pdf/presentation）
hosts/{claude-code,codex,grok,tests}/   宿主真源与恶意样例集
skills/               core 技能运行时镜像（sync-skills 重建，勿手改）
docs/                 设计文档与归档；release-checklist 见 docs/release-checklist.md
```

## License

MIT。
