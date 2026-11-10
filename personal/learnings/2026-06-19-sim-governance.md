---
name: sim-governance
description: "仿真治理 — 仿真后自动清理 wlft*/transcript/*.wlf, 生成 JSON 证据"
metadata:
  type: learning
---

# 仿真治理

**核心**：每次仿真后必须清理临时文件 + 生成验证证据。

## 背景

来自真实 WiFi PHY 项目的数据：
- 61 个 `wlft*` 随机名波形文件污染项目根目录
- 24 个 `vsim_out*.txt` 调试日志堆积
- `prj/.gitignore` 缺少 `wlft*` `work_*/` 等模式

## 解决方案

1. **挂钩**：`engine/hooks/safety/sim-governance.cjs` — PostToolUse 检测 vsim/xsim 命令后自动清理
2. **清理范围**：`wlft*` `transcript` `*.wlf` `vish_stacktrace.vstf` `vsim_stacktrace.vstf` `work_*/`
3. **证据生成**：如 `check_results/` 存在但为空，自动写入基础 JSON 证据
4. **.gitignore**：添加 `wlft*` `work_*/` `*.wdb`

## 应用

- 每个涉及仿真的 session，PostToolUse hook 自动触发
- 配合 [[fix-in-place-discipline]] 使用
- Phase 8 工作流中也包含 cleanup 步骤

**Why**: 仿真垃圾 = git 混乱 + 磁盘浪费 + 无法判断哪些输出是有效的。
**How to apply**: 仿真结束后立即运行清理。证据文件是验证通过的唯一凭证。
