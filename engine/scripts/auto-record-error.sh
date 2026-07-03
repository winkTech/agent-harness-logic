#!/bin/bash
# 自动记录错误 — PostToolUseFailure hook
# 从 stdin 读取 hook 上下文，自动创建错误记录
# 也支持命令行参数直接调用

set -euo pipefail

if [[ "${CLAUDE_HARNESS_VERIFY_READONLY:-}" == "1" || "${CLAUDE_NO_DIAGNOSTIC_WRITES:-}" == "1" || "${CLAUDE_BENCH:-}" == "1" ]]; then
  echo "auto-record-error: skipped in read-only verification mode" >&2
  exit 0
fi

MEMORY_DIR="$HOME/.claude/memory"
ERRORS_DIR="$MEMORY_DIR/errors"
mkdir -p "$ERRORS_DIR"

DATE=$(date +%Y-%m-%d)
TIME=$(date +%H-%M-%S)

# 尝试从 stdin 读取 hook 上下文
STDIN_DATA=""
if [ -p /dev/stdin ] || [ ! -t 0 ]; then
  STDIN_DATA=$(cat 2>/dev/null || true)
fi

# 提取错误信息（从 stdin JSON 或命令行参数）
ERROR_TYPE=""
ERROR_DESC=""
if [ -n "$STDIN_DATA" ]; then
  # 尝试从 JSON 提取 tool name 和 error
  ERROR_TYPE=$(echo "$STDIN_DATA" | grep -o '"name":"[^"]*"' | head -1 | sed 's/"name":"//;s/"//' | tr -d '\n' || true)
  ERROR_DESC=$(echo "$STDIN_DATA" | grep -o '"error":[^,}]*' | head -1 | sed 's/"error"://;s/"//' | cut -c1-200 || true)
  [ -z "$ERROR_TYPE" ] && ERROR_TYPE="hook_failure"
else
  ERROR_TYPE="${1:-hook_failure}"
  ERROR_DESC="${2:-自动记录: PostToolUseFailure}"
fi

[ -z "$ERROR_DESC" ] && ERROR_DESC="自动记录: PostToolUseFailure 触发"

# 文件名
SAFE_TYPE=$(echo "$ERROR_TYPE" | tr -c 'a-zA-Z0-9_-' '_' | cut -c1-30)
ERROR_FILE="$ERRORS_DIR/${DATE}-${SAFE_TYPE}-${TIME}.md"

cat > "$ERROR_FILE" << EOF
---
date: $DATE
time: $TIME
type: error
source: auto-record-error
tool: $ERROR_TYPE
---

# 错误记录: $ERROR_TYPE

## 描述
$ERROR_DESC

## 时间
$DATE $TIME

## 解决方案
[待补充]

## 根因
[待分析]
EOF

echo "auto-record-error: $ERROR_FILE" >&2
exit 0
