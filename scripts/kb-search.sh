#!/bin/bash
# 知识库检索增强脚本
# 用途：优化知识库搜索，提升检索准确率

QUERY=$1
source "$(dirname "$0")/../config.path.sh"

if [ -z "$QUERY" ]; then
    echo "用法: ./kb-search.sh <搜索关键词>"
    echo "示例: ./kb-search.sh 时序约束"
    exit 1
fi

echo "=== 知识库检索: $QUERY ==="
echo ""

# 1. 关键词搜索
echo "🔍 关键词搜索:"
grep -r -l "$QUERY" "$KB_DIR" 2>/dev/null | head -10
echo ""

# 2. 标签搜索
echo "🏷️  标签搜索:"
grep -r "tags:.*$QUERY" "$KB_DIR" 2>/dev/null | head -10
echo ""

# 3. 标题搜索
echo "📄 标题搜索:"
grep -r "^#.*$QUERY" "$KB_DIR" 2>/dev/null | head -10
echo ""

# 4. 相关文档推荐
echo "📚 相关文档:"
grep -r -l "$QUERY" "$KB_DIR" 2>/dev/null | head -10 | while IFS= read -r file; do
    basename "$file" 2>/dev/null
done
echo ""

echo "=== 检索完成 ==="
