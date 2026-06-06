#!/bin/bash
# ============================================================================
# 每周记忆维护 (由 cron 调用)
# 每周一 7:03 运行: 健康评分 + 模式挖掘 + 过期归档
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# 3. 归档过期工作记忆
echo "--- 归档过期 ---"
bash "$SCRIPT_DIR/memory-rotate.sh" --execute
echo ""

echo "=== 维护完成 ==="
