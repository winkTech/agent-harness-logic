# hosts/codex — Codex 宿主接入

一分钟接入：

```bash
node core/engine/scripts/render-codex-hooks.cjs          # 渲染 ~/.codex/hooks.json + ~/.codex/AGENTS.md
node core/engine/scripts/render-codex-hooks.cjs --check  # 期望: 双产物零漂移
```

## 真源链

`registrations.json`（本目录，`${HARNESS_ROOT}` 占位）→ 渲染器（占位展开 + manifest 一致性预检）→ `~/.codex/hooks.json`。AGENTS.md 由 `hosts/claude-code/AGENTS.md` 规则真源投影（消灭手工双拷贝）。

## trusted_hash（重要）

hooks.json 变更后 Codex 要求重信任（`~/.codex/config.toml [hooks.state]`）。渲染器检测失配会提示——**不自动改 config.toml**（信任动作必须人发起）。在 Codex 内重新信任 hooks 即可。

## manifest 剖面

codex transport 子集：PreToolUse / PostToolUse / PreCompact / SessionStart / Stop（8 条目）。`UserPromptSubmit` 是 claude-code 宿主独占（hostOnly）。

## 验证

`--check` exit 0；四幕剧真机（①git push --force 拦截 ②/start 技能 ③SessionStart briefing ④loop-ctl --budget 2 退出）。
