#!/bin/bash
# 记忆检索增强脚本
# 用途：智能检索相关记忆，支持关联推荐

QUERY=$1
source "$(dirname "$0")/../config.path.sh"

if [ -z "$QUERY" ]; then
    echo "用法: ./memory-retrieve.sh <搜索关键词>"
    echo "示例: ./memory-retrieve.sh 'GateGuard'"
    exit 1
fi

echo "=== 记忆检索: $QUERY ==="
echo ""

# 1. 关键词搜索
echo "🔍 关键词搜索:"
grep -r -l "$QUERY" "$MEMORY_DIR" 2>/dev/null | head -10
echo ""

# 2. 按类型搜索
echo "📁 按类型搜索:"
echo "  工作记忆:"
grep -r -l "$QUERY" "$MEMORY_DIR/work" 2>/dev/null | head -5
echo "  错误记录:"
grep -r -l "$QUERY" "$MEMORY_DIR/errors" 2>/dev/null | head -5
echo "  学习总结:"
grep -r -l "$QUERY" "$MEMORY_DIR/learnings" 2>/dev/null | head -5
echo ""

# 3. 关联记忆推荐
echo "🔗 关联记忆推荐:"
# 提取关键词的相关词
RELATED_TERMS=$(echo "$QUERY" | tr ' ' '\n' | head -3)
for term in $RELATED_TERMS; do
    echo "  相关: $term"
    grep -r -l "$term" "$MEMORY_DIR" 2>/dev/null | head -3
done
echo ""

# 4. 最近记忆
echo "🕐 最近记忆:"
find "$MEMORY_DIR" -name "*.md" -mtime -7 2>/dev/null | head -10
echo ""

echo "=== 检索完成 ==="
