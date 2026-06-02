#!/bin/bash
# 语义检索增强脚本
# 用途：基于关键词扩展的语义检索

QUERY=$1
MEMORY_DIR="C:/Users/Lihan/.claude/memory"
KB_DIR="C:/Users/Lihan/.claude/knowledge/primary"

if [ -z "$QUERY" ]; then
    echo "用法: ./semantic-search.sh <搜索关键词>"
    echo "示例: ./semantic-search.sh '时序约束'"
    exit 1
fi

echo "=== 语义检索: $QUERY ==="
echo ""

# 1. 关键词扩展
echo "🔍 关键词扩展:"
# 同义词映射
case $QUERY in
    "时序"|"timing")
        RELATED=("时钟" "约束" "setup" "hold" "skew")
        ;;
    "状态机"|"fsm")
        RELATED=("状态" "转移" "Moore" "Mealy")
        ;;
    "流水线"|"pipeline")
        RELATED=("pipeline" "latency" "throughput")
        ;;
    "复位"|"reset")
        RELATED=("复位" "初始化" "同步" "异步")
        ;;
    *)
        RELATED=("$QUERY")
        ;;
esac

echo "  原始关键词: $QUERY"
echo "  扩展关键词: ${RELATED[*]}"
echo ""

# 2. 多关键词搜索
echo "🔍 多关键词搜索:"
for keyword in "${RELATED[@]}"; do
    echo "  搜索: $keyword"
    grep -r -l "$keyword" "$MEMORY_DIR" 2>/dev/null | head -3
    grep -r -l "$keyword" "$KB_DIR" 2>/dev/null | head -3
done
echo ""

# 3. 上下文搜索
echo "📝 上下文搜索:"
grep -r -B2 -A2 "$QUERY" "$MEMORY_DIR" 2>/dev/null | head -20
echo ""

# 4. 相关记忆推荐
echo "🔗 相关记忆推荐:"
grep -r -l "$QUERY" "$MEMORY_DIR" 2>/dev/null | while IFS= read -r file; do
    basename "$file" 2>/dev/null
done | head -10
echo ""

echo "=== 检索完成 ==="
