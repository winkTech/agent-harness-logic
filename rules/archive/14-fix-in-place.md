---
name: fix-in-place
description: "Fix-in-Place 规则 — 禁止创建文件变体，强制原地修改"
priority: L1
trigger: "涉及 .sv/.v 文件修改时"
---

# Fix-in-Place 规则

> 禁止创建文件变体。已有文件必须原地修改。
> 违反此规则 = 代码库膨胀 → review 成本指数上升。

## 背景

从实际 WiFi PHY 项目中发现的 agent 行为缺陷：
- 一个 freq_recovery 模块产生了 `check_rtl_freq_recovery.sv` 到 `...21.sv` 共 **21 个版本**
- 一个 coarse_timing TB 产生了 `tb_coarse_basic/clk/clk2/final/stim/timing/fast/new.sv` 共 **8 个版本**
- 调试脚本产生了 `run_debug.do` 到 `...21.do` 共 **21 个版本**
- 仿真日志产生了 `vsim_out.txt` 到 `...18.txt` 共 **19 个版本**
- 仿真垃圾文件 `wlft*` 共 **61 个**

**根因**: agent 不知道如何修复已有文件时，倾向于创建新文件版本。这导致代码库膨胀、验证不可信、review 成本指数上升。

## 红线 [MUST NOT]

1. **[MUST NOT]** 创建文件名含 `_v2`, `_v3`, `_new`, `_2`, `_final`, `_basic`, `_clk`, `_stim` 等后缀的 `.sv`/`.v` 文件
2. **[MUST NOT]** 创建 `check_rtl_<module>N.sv` 模式的文件（已有 `check_rtl_<module>.sv` 时）
3. **[MUST NOT]** 创建 `tb_<module>_<variant>.sv` 模式的文件（已有 `tb_<module>.sv` 时）
4. **[MUST NOT]** 创建 `run_debugN.do` 模式的文件（已有 `run_debug.do` 时）

## 规则 [MUST]

1. **[MUST]** 要修改一个已有模块 → `Read` 后 `Write` **覆盖**，不创建新文件
2. **[MUST]** 要创建一个**新模块** → 用 `init-module.sh` 脚手架，不手工创建
3. **[MUST]** 每个模块只允许存在**一个** `tb_<module>.sv`（删除旧的再创建新的）
4. **[MUST]** 每次仿真后**立即清理** `wlft*` `transcript` `*.wlf` 等临时文件
5. **[MUST]** 生成 JSON 证据文件到 `02_sim/check_results/<module>.json`

## 挂钩支持

| 挂钩 | 时机 | 功能 |
|:-----|:-----|:------|
| `fix-in-place-guard.cjs` | PreToolUse | 自动检测并报警文件变体创建 |
| `sim-governance.cjs` | PostToolUse | 自动清理仿真产物 |

## 违反后果

| 违反 | 直接后果 | 长期后果 |
|:-----|:---------|:---------|
| 创建 `_v2.sv` 变体 | review 时被打回 | 代码库不可维护 |
| 创建多 TB 版本 | 不知道哪个有效 | 验证不可信 |
| 不清理仿真产物 | git 被 wlft 污染 | 项目混乱 |
| 无 JSON 证据 | Phase 4.5 阻断 | 流程卡住 |

## 工作流集成

在 `hdl-coding-dag-workflow.js` 的 Phase 4 中:
- 每个模块由独立 agent 处理（per-module pipeline）
- 每个 agent 的 prompt 包含 fix-in-place 指令
- fix-in-place-guard.cjs 挂钩做二次防线
- sim-governance.cjs 挂钩做清理保障
