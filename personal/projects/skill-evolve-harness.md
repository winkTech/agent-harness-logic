---
name: skill-evolve-harness
description: "SkillOpt 方法蒸馏到本地 harness 的决策记录 — session 内容模式挖掘 + held-out 门禁"
metadata:
  type: project
  tags: [skillopt, self-improvement, harness, gate]
---

# SkillOpt 蒸馏到 Harness

**背景**: 尝试安装 SkillOpt-Sleep 插件，发现外部 Python 包集成度低、LLM miner 通过 DeepSeek 代理调用 `claude -p` 延迟过高（10-30s/次）、从真实 session 挖出的任务无 checkable reference 导致 gate 永远 reject。

**决策**: 不依赖外部 SkillOpt-Sleep 包，将核心方法蒸馏为本地 Node.js 脚本。

## 成果

**文件**: `engine/scripts/skill-evolve.cjs`
**Hook**: PostStop (async, timeout=10s)
**Config**: `~/.skillopt-sleep/config.json` (backend: claude)

## 核心循环

```
PostStop hook →
  1. Harvest: SQLite runtime_events (user_correct/drift_stuck/tool_fail) + session JSONL 关键词频率
  2. Mine: 关键词 → RULE_MAP 映射 + 模式挖掘（lint/位宽/golden 等高频问题）
  3. Reflect: 生成 bounded edit（一次只加一条规则）
  4. Validate: 冲突检测（不违反已有规则）
  5. Gate: held-out 门禁（51 个 session, 70% train/30% val, candidate > 5% → accept）
  6. Stage: report.md + diff 到 .skillopt-sleep/staging/evolve-xxx/
```

## 与原始 SkillOpt 的差异

| 维度 | SkillOpt 原始 | 蒸馏版 |
|:-----|:-------------|:--------|
| 数据源 | history.jsonl + LLM mine | SQLite events + session 关键词频率 |
| 任务验证 | LLM judge (claude -p) | 本地冲突检测 (< 1s) |
| 门禁 | held-out replay (API) | held-out session 频率分析 |
| API 开销 | 高（十几分钟） | 零（纯本地） |
| 输出 | proposal 等审查 | 同格式 |

## 当前规则映射表

- 用户挫败信号 → 工作流程 `[SHOULD]`
- 仿真编译错误 → 位宽→时序→逻辑排查 `[MUST]`
- Golden Model 对比 → bit-true 对齐 `[SHOULD]`
- Lint 工具错误 → 语法和位宽检查 `[MUST]`
- 仿真错误 → 端口位宽匹配 `[MUST]`
- 流水线时序 → 插入流水线寄存器 `[SHOULD]`

## 使用方法

```bash
# 正常模式（PostStop hook 自动跑）
node engine/scripts/skill-evolve.cjs

# 强制模式（扫所有 session 内容）
node engine/scripts/skill-evolve.cjs --force

# 试运行
node engine/scripts/skill-evolve.cjs --dry-run --force
```

**Why**: 外部 SkillOpt-Sleep 因 DeepSeek 代理延迟和任务不可验证问题无法产生有效改进。
**How to apply**: 每次 session 结束自动运行，stage 提案到 `.skillopt-sleep/staging/`，审查后手动合并到对应 SKILL.md。
