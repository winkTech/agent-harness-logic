#!/bin/bash
# ============================================================================
# 记忆轮换脚本
# 用途: 将超过 14 天的已完成工作记忆移至 archive/
# 用法:
#   ./scripts/memory-rotate.sh              # 预览（不执行）
#   ./scripts/memory-rotate.sh --execute    # 实际执行轮换
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/../../memory" ]; then PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -d "$SCRIPT_DIR/../memory" ]; then PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else PROJECT_ROOT="$HOME/.claude"; fi
MEMORY_WORK="$PROJECT_ROOT/memory/work"
MEMORY_ARCHIVE="$PROJECT_ROOT/memory/archive"
STALE_DAYS="${2:-14}"
EXECUTE="${1:-preview}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}=== 记忆轮换 | 过期 > ${STALE_DAYS}d ===${NC}"
echo "  源: $MEMORY_WORK"
echo "  目标: $MEMORY_ARCHIVE"
echo "  模式: $([ "$EXECUTE" = "--execute" ] && echo '执行' || echo '预览')"
echo ""

now=$(date +%s)
stale_sec=$((STALE_DAYS * 86400))
moved=0

for f in "$MEMORY_WORK"/*.md; do
    [ -f "$f" ] || continue

    base=$(basename "$f")

    # 跳过模板
    [ "$base" = "TEMPLATE.md" ] && continue

    # 检查是否已完成
    status=$(grep "^status:" "$f" 2>/dev/null | sed 's/^status: *//')
    if [ "$status" != "完成" ] && [ "$status" != "completed" ] && [ "$status" != "complete" ]; then
        continue
    fi

    # 检查修改时间
    mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    age=$((now - mtime))
    if [ $age -lt $stale_sec ]; then
        continue  # 还不够旧
    fi

    age_days=$((age / 86400))
    target="$MEMORY_ARCHIVE/$base"

    if [ -f "$target" ]; then
        echo -e "  ${YELLOW}跳过${NC} (目标已存在): $base"
        continue
    fi

    if [ "$EXECUTE" = "--execute" ]; then
        mv "$f" "$target"
        echo -e "  ${GREEN}已归档${NC} (${age_days}d): $base"
    else
        echo -e "  ${CYAN}可归档${NC} (${age_days}d): $base"
    fi
    moved=$((moved + 1))
done

echo ""
if [ "$moved" -eq 0 ]; then
    echo -e "${GREEN}无文件需要轮换${NC}"
elif [ "$EXECUTE" != "--execute" ]; then
    echo -e "${YELLOW}发现 $moved 个文件可归档。使用 --execute 实际执行。${NC}"
else
    echo -e "${GREEN}已归档 $moved 个文件${NC}"
fi
