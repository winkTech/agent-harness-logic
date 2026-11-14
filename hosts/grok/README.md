# hosts/grok — Grok 宿主接入

一分钟接入：

```bash
node core/engine/scripts/render-grok-hooks.cjs          # claude settings 真源 → 剖面投影 → ~/.grok/hooks.json
node core/engine/scripts/render-grok-hooks.cjs --check  # 期望: 零漂移
node hosts/grok/smoke.cjs                               # 静态 8 检查全绿
```

## 剖面（hostPresets.grok，manifest 声明）

Grok 对 async 条目按前台执行——长钩子会阻塞会话启动（B1 陷阱）。剖面规则：

- **事件子集**五族（PreToolUse/PostToolUse/PostToolUseFailure/SessionStart/Stop）
- **长钩子跳过**：memory-maintenance（120s，改由 spool 消费者调度）、codegraph `--session`（60s，保留 `--file` 增量）
- **async 剥离** + **超时 cap 30s**
- **matcher 翻译**：startup|resume → new|load
- 工具别名：run_terminal_command → Bash（引擎归一层翻译）

## 遥测

Grok 遥测只走 spool（亚毫秒落盘 + 后台消费，Phase 2.5）。

## 冒烟

`smoke.cjs`：静态 8 检查（零漂移/剖面不变量×5/技能供给/spool 可写）+ `--live` 四幕剧操作清单（含会话启动 <5s 断言）。

## 前提说明

Grok 兼容读 claude 式 hooks 注册为方案前提——首装后在 Grok Build 会话实测四幕剧确认。
