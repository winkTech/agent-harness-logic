#!/bin/bash
# 自动解析 everything-claude-code 插件最新版本路径
# 防止插件升级后 hooks 因版本号写死而静默失效
PLUGIN_HOOK="$1"  # session-end.js | session-start.js
PLUGIN_DIR=$(ls -dt ~/.claude/plugins/cache/everything-claude-code/everything-claude-code/*/ 2>/dev/null | head -1)
if [ -z "$PLUGIN_DIR" ] || [ ! -d "$PLUGIN_DIR" ]; then
  echo "ERROR: everything-claude-code plugin not found" >&2
  exit 1
fi
HOOK_FILE="${PLUGIN_DIR}scripts/hooks/${PLUGIN_HOOK}"
if [ ! -f "$HOOK_FILE" ]; then
  echo "ERROR: Hook script not found: $HOOK_FILE" >&2
  exit 1
fi
exec node "$HOOK_FILE"
