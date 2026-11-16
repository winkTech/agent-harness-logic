---
name: fix-in-place-discipline
description: "Fix-in-Place 纪律 — agent 必须原地修改文件，禁止创建 _v2/_new/check_rtl_N 等变体"
metadata:
  type: learning
---

# Fix-in-Place 纪律

**核心**：Agent 不允许创建文件变体。必须原地修改已有文件。

## 背景

来自真实 WiFi PHY 项目的证据：
- `check_rtl_freq_recovery.sv` → `...21.sv`：**21 个版本**
- `tb_coarse_basic/clk/clk2/final/stim`：**8 个版本**
- `run_debug.do` → `...21.do`：**21 个版本**

根因：agent 在不知道怎么修复已有文件时，选择创建新文件版本。

## 解决方案

1. **规则**：`rules/14-fix-in-place.md` — L1 红线，第零条级别
2. **挂钩**：`engine/hooks/safety/fix-in-place-guard.cjs` — PreToolUse 检测 Write/Bash 中的变体文件名（5 个正则）
3. **工作流**：Phase 4 每个模块独立 agent + prompt 内嵌 fix-in-place 指令

## 直接相关的变体模式（必须拦截）

| 模式 | 示例 | 正则 |
|:-----|:-----|:------|
| 版本号后缀 | `scrambler_v2.sv` | `/_v\d+\.(sv\|v)$/` |
| 数字后缀 | `freq_recovery_2.sv` | `/_\d+\.(sv\|v)$/` |
| 关键字变体 | `tb_coarse_basic.sv` | `/_(new\|final\|basic\|clk\|stim\|fast)\d*\.(sv\|v)$/` |
| check_rtl 序号 | `check_rtl_freq_recovery21.sv` | `/^check_rtl_\w+\d+\.sv$/` |
| debug 序号 | `run_debug5.do` | `/^run_debug\d+\.do$/` |

## 应用

- 所有涉及 `.sv`/`.v` 文件 Write/Bash 操作的 session
- 配合 [[sim-governance]] 一起使用
- 参见：[[rules/14-fix-in-place.md]]

**Why**: 文件变体 = 代码库不可维护 + review 成本指数上升 + 验证不可信。
**How to apply**: 任何 session 中，agent 要写新文件时先检查是否已有同名文件。有则覆盖，不创建变体。
