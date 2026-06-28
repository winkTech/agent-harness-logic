#!/bin/bash
# 上下文压缩前自动 checkpoint
# 由 PreCompact hook 调用，记录压缩事件
# 用法: ./ctx-checkpoint.sh [项目名]
#   - 不传参数: 保存到 var/work/ctx-checkpoints/
#   - 传项目名: 保存到 memory/projects/<项目名>/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$SCRIPT_DIR/../.."
PROJECT_NAME="${1:-}"

TS=$(date '+%Y%m%d_%H%M%S')

if [ -n "$PROJECT_NAME" ]; then
    TARGET_DIR="$HARNESS_DIR/memory/projects/$PROJECT_NAME"
else
    TARGET_DIR="$HARNESS_DIR/var/work/ctx-checkpoints"
fi

mkdir -p "$TARGET_DIR"
FILE="$TARGET_DIR/ctx-compact-$TS.md"

cat > "$FILE" << ENDMEMO
---
name: ctx-compact-$TS
description: 上下文自动压缩记录 ($TS)
metadata:
  type: project
  timestamp: $TS
---

**自动记录**：上下文在 $TS 被自动压缩。

ENDMEMO

echo "[ctx-checkpoint] Saved: $FILE"
