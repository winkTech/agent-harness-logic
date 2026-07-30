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

# 3. 记忆/知识库维护：过期压缩、归档降权、语义索引重建、归因驱动的记忆退役
echo "--- 记忆/知识库维护 ---"
node "$SCRIPT_DIR/memory-knowledge-maintenance.cjs" --auto --execute --interval-days 7
echo ""

# 4. 周报表：误报率、交付率、hook 延迟、守卫覆盖率、规划对账
#    这些报表只读，不改状态；任一失败不应中断维护，故显式容错。
echo "--- 门禁误报率 (FPR) ---"
node "$SCRIPT_DIR/fp-rate-tracker.cjs" report || echo "[weekly] fp-rate report 不可用"
echo ""

echo "--- 交付率 (30 天窗口) ---"
node "$SCRIPT_DIR/delivery-tracker.cjs" report || echo "[weekly] delivery report 不可用"
echo ""

echo "--- Hook 延迟 p50/p95 ---"
node "$SCRIPT_DIR/lib/hook-latency.cjs" || echo "[weekly] latency report 不可用"
echo ""

echo "--- 守卫模式覆盖率 ---"
node "$SCRIPT_DIR/guard-coverage.cjs" || echo "[weekly] 存在未被 case 覆盖的守卫类别 (见上)"
echo ""

echo "--- 规划对账 (plan-accuracy) ---"
node "$SCRIPT_DIR/plan-accuracy.cjs" report || echo "[weekly] plan-accuracy report 不可用"
echo ""

# 5. 十维仪表盘：月度复评的唯一证据源，未达标维度以非零退出提示（不中断维护）
echo "--- 十维仪表盘 ---"
node "$SCRIPT_DIR/ten-dimension-dashboard.cjs" || echo "[weekly] 存在未达标维度 (见上)"
echo ""

echo "=== 维护完成 ==="
