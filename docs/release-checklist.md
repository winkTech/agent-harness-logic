# 发布前检查清单

每次对外发布（push 主分支 / marketplace 更新）前逐项过。

## 分发面

- [ ] `node core/engine/scripts/sync-plugin-dist.cjs`（重建 dist）
- [ ] `--check` 零漂移（dist 与 marketplace sha 同步）
- [ ] `__REPO_URL__` / `__OWNER__` 已替换为真实值（发布期动作；开发期保持占位）
- [ ] marketplace 条目 sha = 40 位且与 dist 树一致（`bench-d2-plugin-validate.cjs` PASS）

## 结构合规

- [ ] 技能/插件名全 kebab-case（D-2 校验）
- [ ] hooks 命令用 `${CLAUDE_PLUGIN_ROOT}` 相对引用（无本机绝对路径）
- [ ] 无 async 依赖的分发项（grok 剖面 async 剥离已在渲染器保证）
- [ ] Windows 路径 <260（深嵌套目录检查）

## 脱敏

- [ ] `node core/engine/scripts/bench-d1-desens.cjs` = 0 命中
- [ ] dist 树零个人信息（D-2 第 6 面内含）
- [ ] git 历史清洗决策已做（若对外开源：filter-repo 或新仓 squash——§13 R5）

## 质量门

- [ ] `harness-ci.cjs` 六段绿
- [ ] `run-all-tests.cjs --no-persist`：失败数 = 基线 4（行为级已知项）
- [ ] `bench-refactor --phase 2` overall=pass（H-5/P-4/H-4）
- [ ] `bench-refactor --phase 4` overall=pass（D-1/D-2）
- [ ] `layer-boundary.cjs --check` violations=0

## 宿主冒烟（人工，三宿主同批）

- [ ] claude-code：四幕剧（①危险命令拦截 ②技能触发 ③SessionStart 恢复 ④小 budget 循环退出）
- [ ] codex：四幕剧 + trusted_hash 重信任完成
- [ ] grok：四幕剧 + 会话启动 <5s + 遥测仅 spool

## 版本

- [ ] `.claude-plugin/plugin.json` 与 dist 三清单 version 一致
- [ ] CHANGELOG（如有）更新
