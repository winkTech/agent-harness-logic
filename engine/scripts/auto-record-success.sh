#!/bin/bash
# 自动记录成功 — PostToolUse hook (Write/Edit 成功后触发)
# 从 stdin 读取 hook 上下文，记录项目进度
set -euo pipefail

WORK_DIR="$HOME/.claude/memory/work"
mkdir -p "$WORK_DIR"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H-%M-%S)

STDIN_DATA=""
[ -p /dev/stdin ] || [ ! -t 0 ] && STDIN_DATA=$(cat 2>/dev/null || true)

SUCCESS_TYPE=""
SUCCESS_DESC=""
if [ -n "$STDIN_DATA" ]; then
  SUCCESS_TYPE=$(echo "$STDIN_DATA" | grep -o '"name":"[^"]*"' | head -1 | sed 's/"name":"//;s/"//' || true)
  [ -z "$SUCCESS_TYPE" ] && SUCCESS_TYPE="tool_success"
  SUCCESS_DESC="工具 $SUCCESS_TYPE 执行成功"
else
  SUCCESS_TYPE="${1:-milestone}"
  SUCCESS_DESC="${2:-项目进度记录}"
fi

SAFE_TYPE=$(echo "$SUCCESS_TYPE" | tr -c 'a-zA-Z0-9_-' '_' | cut -c1-30)
SUCCESS_FILE="$WORK_DIR/${DATE}-${SAFE_TYPE}-${TIME}.md"

cat > "$SUCCESS_FILE" << EOF
---
date: $DATE
time: $TIME
type: milestone
source: auto-record-success
tool: $SUCCESS_TYPE
---

# 进度记录: $SUCCESS_TYPE

## 描述
$SUCCESS_DESC

## 时间
$DATE $TIME
EOF

echo "auto-record-success: $SUCCESS_FILE" >&2
exit 0
