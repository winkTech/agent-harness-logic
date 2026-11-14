# hosts/claude-code — 基座宿主接入

一分钟接入：

```bash
node core/engine/scripts/render-hook-settings.cjs        # 渲染 settings.json + workbuddy.hooks.json + plugin.hooks.json
node core/engine/scripts/render-hook-settings.cjs --check  # 期望: 三产物一致
```

## 本目录内容

| 文件 | 作用 |
|---|---|
| `registrations.json` | claude-code 注册真源（render-hook-settings 消费） |
| `CLAUDE.md` / `AGENTS.md` | 规则真源模板（sync-skills 渲染根入口文件） |
| `permissions.template.json` | settings.local.json 结构模板（allow/deny 骨架，新机器复制即用） |
| `statusline.{sh,cjs}` | 状态栏（settings 内联引用为 Node 版，无路径耦合） |
| `perf-monitor.sh` | 历史巡检工具（无引擎依赖） |

## 权限接入

把 `permissions.template.json` 的 `permissions` 段并入 `~/.claude/settings.local.json`；env 调参项本机自维护（不走分发）。

## 验证

`render-hook-settings --check` exit 0 = 零漂移；四幕剧（H-3 claude）见 `docs/release-checklist.md`。
