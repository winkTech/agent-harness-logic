#!/bin/bash
# 自动解析 everything-claude-code / ECC 插件路径
# 防止插件升级后 hooks 因版本号写死而静默失效
PLUGIN_HOOK="$1"  # session-end.js | session-start.js

# 尝试多个已知位置
for BASE in \
  "$HOME/.claude/var/plugins/marketplaces/ecc" \
  "$HOME/.claude/var/plugins/marketplaces/ecc@ecc" \
  "$HOME/.claude/var/plugins/marketplaces/everything-claude-code" \
  "$HOME/.claude/var/plugins/cache/everything-claude-code/everything-claude-code/"*/; do
  if [ -d "$BASE" ] && [ -f "${BASE}/scripts/lib/utils.js" ]; then
    PLUGIN_DIR="$BASE"
    break
  fi
done

if [ -z "${PLUGIN_DIR:-}" ] || [ ! -d "$PLUGIN_DIR" ]; then
  echo "ERROR: ECC plugin not found (tried var/plugins/marketplaces/, cache/)" >&2
  exit 1
fi

HOOK_FILE="${PLUGIN_DIR}/scripts/hooks/${PLUGIN_HOOK}"
if [ ! -f "$HOOK_FILE" ]; then
  echo "ERROR: Hook script not found: $HOOK_FILE" >&2
  exit 1
fi
exec node "$HOOK_FILE"
