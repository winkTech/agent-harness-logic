---
name: file-variant-explosion
description: "Agent 无 fix-in-place 纪律 → 21 个文件版本, 8 个 TB 版本, 61 个 wlft 垃圾 — WiFi PHY 项目"
metadata:
  type: error
---

# Agent 文件变体爆炸 — WiFi PHY 项目

## 现象

在 `D:\Project_Files\ofdm\wifi_example\` WiFi PHY 项目中，agent 产生了大量文件变体和仿真垃圾：

| 类别 | 数量 | 示例 |
|:-----|:----:|:-----|
| check_rtl 变体 | 21 | `check_rtl_freq_recovery.sv` ~ `...21.sv` |
| TB 变体 | 8 | `tb_coarse_basic/clk/clk2/final/stim/fast/new.sv` |
| run_debug 变体 | 21 | `run_debug.do` ~ `...21.do` |
| vsim 日志 | 19 | `vsim_out.txt` ~ `...18.txt` |
| wlft 垃圾 | 61 | `wlftxxxxx` 随机名波形文件 |
| 总计 | **130** | |

## 根因

1. **无 fix-in-place 规则** — agent 不知道要原地修改，每次创建新文件
2. **Phase 4 是 monolithic agent** — 35 模块塞一个 context → 溢出 → 质量崩溃
3. **无仿真治理** — 每次 debug 产生新文件，无人清理
4. **.gitignore 不完善** — `wlft*` `work_*/` 模式缺失

## 修复

- 创建 `rules/14-fix-in-place.md` — L1 红线
- 创建 `fix-in-place-guard.cjs` — PreToolUse hook 阻断变体
- 创建 `sim-governance.cjs` — PostToolUse 自动清理
- 重构 Phase 4 为 per-module pipeline
- 加固 `.gitignore`（添加 `wlft*` `work_*/` `*.wdb`）
- 清理 130 个文件变体 + 仿真垃圾（commit `c275714`）

## 教训

**文件变体不是版本控制**。Git 才是版本控制。Agent 创建新文件 = 逃避问题。

**Why**: 无纪律的 agent 迭代 = 代码库膨胀 10 倍 + 不可维护。
**How to apply**: 每 session 开始时加载 `rules/14-fix-in-place.md`。遇到 agent 创建变体时立即终止并强制原地修改。
