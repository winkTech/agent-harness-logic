#!/bin/bash
# 自动记录成功 — PostToolUse hook (Write/Edit 成功后触发)
# 从 stdin 读取 hook 上下文，记录项目进度
set -euo pipefail

if [[ "${CLAUDE_HARNESS_VERIFY_READONLY:-}" == "1" || "${CLAUDE_NO_DIAGNOSTIC_WRITES:-}" == "1" || "${CLAUDE_BENCH:-}" == "1" ]]; then
  echo "auto-record-success: skipped in read-only verification mode" >&2
  exit 0
fi

WORK_DIR="$HOME/.claude/memory/work"
mkdir -p "$WORK_DIR"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H-%M-%S)

STDIN_DATA=""
[ -p /dev/stdin ] || [ ! -t 0 ] && STDIN_DATA=$(cat 2>/dev/null || true)

SUCCESS_TYPE=""
SUCCESS_DESC=""
if [ -n "$STDIN_DATA" ]; then
  # Hook 路径（PostToolUse）。原实现取 "name" 字段, 但载荷字段是 tool_name 且带空格,
  # 永远匹配不上 -> 每次 Write/Edit 都落到兜底分支写一条无信息量的
  # "工具 tool_success 执行成功", 7 天累积 110 个空壳稀释记忆语料。
  # 工具级动作已由 engine/scripts/hooks/agent-transparency-ledger.cjs 完整记录,
  # 本脚本不再重复。故 hook 路径只在能提取到工具名时记录, 且仅记录一次每日汇总,
  # 无法提取时静默跳过, 不写盘。
  SUCCESS_TYPE=$(echo "$STDIN_DATA" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true)
  [ -z "$SUCCESS_TYPE" ] && exit 0
  SAFE_PROBE=$(printf '%s' "$SUCCESS_TYPE" | tr -c 'a-zA-Z0-9_-' '_' | cut -c1-30)
  # 每工具每日只留一条, 避免逐次写盘
  if ls "$WORK_DIR/${DATE}-${SAFE_PROBE}-"*.md >/dev/null 2>&1; then exit 0; fi
  SUCCESS_DESC="当日首次 $SUCCESS_TYPE 成功（逐次动作见 transparency ledger）"
else
  # 手动路径: auto-record-success.sh <类型> <描述> —— 里程碑记录, 保留。
  SUCCESS_TYPE="${1:-milestone}"
  SUCCESS_DESC="${2:-项目进度记录}"
fi

# printf 而非 echo: echo 的换行会被 tr 转成尾随 '_'（旧文件名 tool_success_ 即因此）
SAFE_TYPE=$(printf '%s' "$SUCCESS_TYPE" | tr -c 'a-zA-Z0-9_-' '_' | cut -c1-30)
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
