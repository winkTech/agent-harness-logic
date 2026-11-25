# 发布前检查清单

每次对外发布（push 主分支 / marketplace 更新）前逐项过。

## 合入/切分支后复位（先于一切检查）

merge 或 checkout 后，旧分支同名 tracked 产物会覆盖渲染版、gitignore 的运行时镜像（skills/）会残缺、插件产物可能与源码不一致——依次重建并全验：

```bash
node core/engine/scripts/sync-skills.cjs
node core/engine/scripts/sync-workflow-mirror.cjs
node core/engine/scripts/render-hook-settings.cjs
node core/engine/scripts/render-codex-hooks.cjs
node core/engine/scripts/render-grok-hooks.cjs
node core/engine/scripts/sync-plugin-dist.cjs   # 从受版本管理的技能与引擎组装插件
node core/engine/scripts/harness-ci.cjs          # render family 六渲染器须全绿
```

## 分发面

- [ ] `node core/engine/scripts/sync-plugin-dist.cjs`（重建 dist）
- [ ] `node core/engine/scripts/sync-plugin-dist.cjs --check` 校验本地包以及两个 marketplace 清单。
- [ ] 发布用提交必须包含完整的 `dist/plugin`（此目录默认忽略，可用 `git add -f -- dist/plugin` 精确暂存）。保留这个提交的完整 SHA。
- [ ] 对该提交运行 `node core/engine/scripts/sync-plugin-dist.cjs --release --repo-url=<仓库HTTPS地址> --owner=<所有者> --commit=<完整SHA>`。只有 Git 中的插件文件与本次组装一致才生成发布清单。使用相同参数附加 `--check` 可只读复核。
- [ ] 发布包含两个清单和同一份 `dist/plugin` 的版本，并确保插件提交对安装者可访问。Claude 使用固定提交，Grok 从同一发行版本读取相对路径。

本机 Codex 安装或更新插件时，从 Harness 源码根运行：

```powershell
npm.cmd run codex:connect
npm.cmd run codex:connect -- --check
```

本机 Antigravity 安装或更新插件时（方案 A 瘦链接，本体位于 `hosts/antigravity/`），从 Harness 源码根运行：

```powershell
npm.cmd run antigravity:connect
npm.cmd run antigravity:connect -- --check
npm.cmd run antigravity:test
```

从本地源码更新同版本插件时，运行 `npm.cmd run codex:connect -- --refresh`。入口比较生成产物和安装缓存，有内容变化才重新安装。首次使用、Hook 定义变化或宿主在重装后要求重新审核时，Codex 会提示确认。若待审列表还包含其他来源，选择 **Review hooks**，只确认目标插件。使用过独立版 Harness 的机器，可在接入命令后加上 `-- --dedupe`。入口等插件 Hook 全部获准后，使用 Codex 的配置接口停用已核实的重叠 User 条目。跳过审核后可再次执行接入命令。

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
- [ ] `run-all-tests.cjs --no-persist`：失败数为 0，核对环境相关的跳过项。
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
