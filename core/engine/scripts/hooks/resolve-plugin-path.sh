#!/bin/bash
# 自动解析 everything-claude-code / ECC 插件路径
# 防止插件升级后 hooks 因版本号写死而静默失效
PLUGIN_HOOK="$1"  # session-end.js | session-start.js

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../config.path.sh
source "$SCRIPT_DIR/../../config.path.sh"

# 尝试多个已知位置
for BASE in \
  "$VAR_DIR/plugins/marketplaces/ecc" \
  "$VAR_DIR/plugins/marketplaces/ecc@ecc" \
  "$VAR_DIR/plugins/marketplaces/everything-claude-code" \
  "$VAR_DIR/plugins/cache/everything-claude-code/everything-claude-code/"*/; do
  if [ -d "$BASE" ] && [ -f "${BASE}/scripts/lib/utils.js" ]; then
    PLUGIN_DIR="$BASE"
    break
  fi
done

if [ -z "${PLUGIN_DIR:-}" ] || [ ! -d "$PLUGIN_DIR" ]; then
  # 无插件 = 合法配置，不阻断启动流程
  echo "INFO: No ECC plugin installed — skipping" >&2
  exit 0
fi

HOOK_FILE="${PLUGIN_DIR}/scripts/hooks/${PLUGIN_HOOK}"
if [ ! -f "$HOOK_FILE" ]; then
  echo "ERROR: Hook script not found: $HOOK_FILE" >&2
  exit 1
fi
exec node "$HOOK_FILE"
