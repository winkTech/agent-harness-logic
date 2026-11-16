---
name: memory-auto-trigger
description: 记忆系统三层自动化 — PostMessage 活动跟踪 + SessionStart 过期检查 + Cron 定时清理
metadata:
  type: reference
---

# 记忆系统自动化结构

## 架构

```
PostMessage hook          SessionStart hook           Cron (每周一 7:03)
    │                          │                           │
    ▼                          ▼                           ▼
memory-track.sh          memory-track.sh              memory-cleanup.sh
post-message 模式        session-start 模式            --archive 模式
    │                          │                           │
    ▼                          ▼                           ▼
写入 .last-active        运行 cleanup --dry-run       归档过期条目
(时间戳)                 + 检查上次活动间隔           → memory/archive/
```

## 三个触发器

### 1. PostMessage（每次回复后）
- **脚本**: `scripts/hooks/memory-track.sh post-message`
- **行为**: 更新时间戳 `memory/.last-active`
- **目的**: 让 SessionStart 能判断"多久没活动了"
- **async**: true（不阻塞回复）

### 2. SessionStart（每次会话启动）
- **脚本**: `scripts/hooks/memory-track.sh session-start`
- **行为**:
  - 检查 `.last-active`，如超过 7 天未活动则提醒
  - 运行 `memory-cleanup.sh --dry-run` 预览过期条目
- **配置**: `settings.local.json` → hooks.SessionStart 第二项

### 3. Cron（每周一 7:03）
- **脚本**: `memory-cleanup.sh --archive`
- **行为**: 自动归档过期的 work/error/project 条目
- **持久化**: 写入 `.claude/scheduled_tasks.json`
- **注意**: 每 7 天自动过期，需续期

## 效果

| 维度 | 改进前 | 改进后 |
|------|--------|--------|
| 活动追踪 | 无 | 每次回复记录时间戳 |
| 启动检查 | 无 | 自动提示过期记忆 |
| 自动清理 | 手动运行 | 每周一自动归档 |

## 配置位置
- `settings.local.json` → hooks.PostMessage / hooks.SessionStart
- `.claude/scheduled_tasks.json` → cron 持久化记录
