#!/bin/bash
# ============================================================================
# 上下文管理环境变量 — Claude Code 启动前 source 此文件
# ============================================================================
# 用法: source engine/scripts/set-context-env.sh
# 或加入 ~/.bashrc:  echo "source ~/.claude/engine/scripts/set-context-env.sh" >> ~/.bashrc
# ============================================================================

# 自动压缩阈值：从默认 ~83% 降到 55%
# 模型在 55% 时质量开始下降，提前压缩保留摘要质量
export CLAUDE_AUTOCOMPACT_PCT=55

# 可选：限制最大上下文窗口（防止单 session 过度膨胀）
# export CLAUDE_MAX_CONTEXT_WINDOW=400000

echo "[context-env] CLAUDE_AUTOCOMPACT_PCT=55 已设置"
echo "[context-env] 上下文将在 55% 时自动压缩（默认 ~83%）"