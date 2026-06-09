#!/bin/bash
# 记忆系统跟踪脚本
# 用途: PostMessage 记录活动时间戳 + SessionStart 检查过期记忆
# 用法: memory-track.sh post-message | memory-track.sh session-start

set -euo pipefail

MEMORY_DIR="$HOME/.claude/memory"
TRACK_FILE="$MEMORY_DIR/.last-active"
CLEANUP_SCRIPT="$HOME/.claude/scripts/memory-cleanup.sh"

case "${1:-}" in
    "post-message")
        # 记录最后活动时间
        mkdir -p "$MEMORY_DIR"
        date +%s > "$TRACK_FILE"
        ;;

    "session-start")
        # 1. 检查上次活动时间
        if [ -f "$TRACK_FILE" ]; then
            LAST=$(cat "$TRACK_FILE")
            NOW=$(date +%s)
            GAP=$(( (NOW - LAST) / 86400 ))
            if [ "$GAP" -gt 7 ]; then
                echo "⏰ 已 $GAP 天未活动，建议执行 memory-cleanup.sh 检查过期记忆"
            fi
        fi

        # 2. 运行记忆清理检查（dry-run 模式）
        if [ -f "$CLEANUP_SCRIPT" ]; then
            echo ""
            bash "$CLEANUP_SCRIPT" --dry-run 2>/dev/null || true
            echo ""
        fi
        ;;

    *)
        echo "用法: $0 post-message | session-start"
        exit 1
        ;;
esac
