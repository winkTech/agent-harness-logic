#!/bin/bash
# ============================================================================
# 每周记忆维护 (由 cron 调用)
# 每周一 7:03 运行: 健康评分 + 模式挖掘 + 过期归档
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 从 hook 调用时路径为 engine/scripts/ → PROJECT_ROOT = ~/.claude
if [ -d "$SCRIPT_DIR/../../memory" ]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -d "$SCRIPT_DIR/../memory" ]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  PROJECT_ROOT="$HOME/.claude"
fi

echo "=== 每周记忆维护 | $(date) ==="
echo ""

# 1. 健康评分
echo "--- 健康评分 ---"
bash "$SCRIPT_DIR/memory-health-score.sh" --rank
echo ""

# 2. 模式挖掘
echo "--- 模式挖掘 ---"
bash "$SCRIPT_DIR/memory-pattern-miner.sh" --topics
echo ""

# 3. 记忆/知识库维护：过期压缩、归档降权、语义索引重建
echo "--- 记忆/知识库维护 ---"
node "$SCRIPT_DIR/memory-knowledge-maintenance.cjs" --auto --execute --interval-days 7
echo ""

echo "=== 维护完成 ==="
