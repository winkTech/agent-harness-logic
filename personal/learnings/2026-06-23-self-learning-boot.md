---
name: 2026-06-23-self-learning-boot
aliases: [self-learning-system, self-learning-boot]
description: 自学习系统启动报告：Dream、Skill-Evolve、信号采集 pipeline 激活
created: 2026-06-23
type: learning
---

# 自学习系统启动报告

> 2026-06-23，全面激活自学习 pipeline。

## 状态

| 组件 | 状态 | 说明 |
|:-----|:-----|:------|
| ✅ 信号采集器 | 运行中 | `signal-collector.cjs` 支持 13 种事件类型 |
| ✅ 事件存储 | 运行中 | SQLite `runtime_events` 表，CHECK 约束已修复 |
| ✅ 技能追踪 | 运行中 | `skill-tracker-hook.cjs` 记录技能触发和成功率 |
| ✅ Dream 提炼 | 运行中 | `dream-consolidate.cjs` 模式检测 + 置信度升级 |
| ✅ Dream 注入 | 运行中 | `dream-startup-inject.cjs` SessionStart 时注入 |
| ✅ Skill-Evolve | 运行中 | `skill-evolve.cjs` 纠正信号 → 改进提案 |
| ✅ 记忆同步 | 运行中 | 22 条历史学习已同步到 SQLite FTS5 |
| ✅ 认知切换 | 运行中 | `frustration-detector.cjs` + `mode-switch` |
| ⬜ 观察者钩子 | 依赖 ECC 插件 | `observe-runner.js` 需安装 everything-claude-code |

## 修复项

1. **`002-fix-events-check` 迁移** — `runtime_events` 表 CHECK 约束只允许 7 种原始事件类型，导致 `signal-collector.cjs` v2.0 新增的 6 种类型（`rule_load`/`context_pressure`/`mode_switch`/`memory_cross_ref`/`session_handoff`/`loop_skip`）写入静默失败。已重建表移除 CHECK。

## 数据流

```
用户/系统 → signal-collector.cjs → runtime_events (SQLite)
                                                         ↕
                               dream-consolidate.cjs → facts/learnings
                                                         ↕
                               dream-startup-inject.cjs → 次日 Session 注入
                                                         
用户纠正 → skill-evolve.cjs → .skillopt-sleep/staging/ → SKILL.md 改进
```

## Skill-Evolve 首次产出

从 35 个历史 session 中挖掘出 2 个通过门禁的改进提案：
- `hdl-coding/验证`: 仿真报错先检查端口位宽匹配
- `hdl-coding/必读红线`: 仿真工具错误先检查语法和位宽

## 后续

- 系统每日自动进行 Dream 提炼（SessionStart 时检查）
- Skill-Evolve 在 PostStop 时自动运行
- 考观察者钩子（`observe-runner.js`）需安装 `everything-claude-code` 插件
