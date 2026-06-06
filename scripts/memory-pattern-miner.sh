#!/bin/bash
# ============================================================================
# 记忆模式挖掘脚本 (元认知)
# 用途: 扫描记忆库，发现重复主题/冲突/模式
# 用法:
#   ./scripts/memory-pattern-miner.sh              # 全量分析
#   ./scripts/memory-pattern-miner.sh --topics      # 只看主题聚类
#   ./scripts/memory-pattern-miner.sh --conflicts   # 只看冲突检测
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MEMORY_DIR="$PROJECT_ROOT/memory"

MODE="${1:-all}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================================================
# 主题聚类: 按标签/tags聚类记忆
# ============================================================================
extract_topics() {
    echo -e "${CYAN}=== 主题聚类 ===${NC}"
    echo ""

    # 收集所有 memory 中的 name → 建立主题索引
    echo -e "${YELLOW}记忆分类概览:${NC}"
    echo ""

    # 按 type 分类
    grep -rh "^type:" "$MEMORY_DIR" --include="*.md" 2>/dev/null \
        | sed 's/^type: *//' \
        | sort | uniq -c | sort -rn \
        | while IFS= read -r line; do
            count=$(echo "$line" | awk '{print $1}')
            t=$(echo "$line" | awk '{$1=""; print $0}' | sed 's/^ //')
            echo "  ${t}: ${count} 个记忆"
        done

    echo ""

    # 按 directory 分类
    echo -e "${YELLOW}目录分布:${NC}"
    for dir in learnings work errors archive projects; do
        count=$(find "$MEMORY_DIR/$dir" -name "*.md" -type f 2>/dev/null | wc -l)
        [ "$count" -gt 0 ] && echo "  ${dir}: ${count} 个文件"
    done
}

# ============================================================================
# 冲突检测: 检查是否有矛盾的记忆
# ============================================================================
detect_conflicts() {
    echo -e "${CYAN}=== 冲突检测 ===${NC}"
    echo ""

    # 找具有相同或相似 name 的条目 (可能重复)
    names=$(grep -r "^name:" "$MEMORY_DIR" --include="*.md" -h | sed 's/^name: *//' | sort)
    dupes=$(echo "$names" | uniq -d)
    if [ -n "$dupes" ]; then
        echo -e "${YELLOW}⚠️  发现重复名称:${NC}"
        echo "$dupes" | while IFS= read -r name; do
            echo "  [[$name]]"
            grep -rl "^name: $name$" "$MEMORY_DIR" --include="*.md" | while IFS= read -r f; do
                echo "    → ${f#$PROJECT_ROOT/}"
            done
        done
    else
        echo -e "${GREEN}✅ 无重复名称冲突${NC}"
    fi
    echo ""

    # 孤立检测: 检查死链
    echo -e "${YELLOW}孤立链接检查:${NC}"
    orphan_count=0
    for f in "$MEMORY_DIR"/learnings/*.md "$MEMORY_DIR"/work/*.md "$MEMORY_DIR"/errors/*.md; do
        [ -f "$f" ] || continue
        name=$(grep "^name: " "$f" 2>/dev/null | sed 's/^name: //')
        [ -z "$name" ] && continue
        refs=$(grep -r "\[\[$name\]\]" "$MEMORY_DIR" --include="*.md" 2>/dev/null | grep -v "$f" | wc -l || true)
        if [ "$refs" -eq 0 ]; then
            orphan_count=$((orphan_count + 1))
            echo "  📄 ${f#$PROJECT_ROOT/}"
        fi
    done
    if [ "$orphan_count" -eq 0 ]; then
        echo -e "  ${GREEN}✅ 无孤立活动文件${NC}"
    else
        echo -e "  ${YELLOW}${orphan_count} 个孤立文件${NC}"
    fi
}

# ============================================================================
# 模式建议: 推荐新的关联
# ============================================================================
suggest_links() {
    echo -e "${CYAN}=== 关联建议 ===${NC}"
    echo ""

    # 找 description 中的常见词，推荐相关联
    grep -rh "^description:" "$MEMORY_DIR"/learnings/*.md "$MEMORY_DIR"/work/*.md 2>/dev/null \
        | sed 's/^description: //' \
        | tr ' ' '\n' \
        | grep -E '[一-龥]' \
        | sed 's/[，。、；：]//g' \
        | sort | uniq -c | sort -rn \
        | head -10 \
        | while IFS= read -r line; do
            count=$(echo "$line" | awk '{print $1}')
            word=$(echo "$line" | awk '{$1=""; print $0}' | sed 's/^ //')
            [ -n "$word" ] && echo "  ${word}: ${count} 次"
        done
}

# ============================================================================
# Main
# ============================================================================
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  记忆模式挖掘  |  $(date +%Y-%m-%d)${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo ""

case "$MODE" in
    --topics)
        extract_topics
        ;;
    --conflicts)
        detect_conflicts
        ;;
    *)
        extract_topics
        echo ""
        detect_conflicts
        echo ""
        suggest_links
        ;;
esac

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}建议: 查看 health-score 了解详细评分${NC}"
echo -e "  bash $SCRIPT_DIR/memory-health-score.sh --rank"
echo ""
