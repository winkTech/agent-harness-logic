#!/bin/bash
# 智能推荐脚本
# 用途：基于当前任务推荐相关记忆和知识

TASK=$1
MEMORY_DIR="C:/Users/Lihan/.claude/memory"
KB_DIR="C:/Users/Lihan/.claude/knowledge/primary"

if [ -z "$TASK" ]; then
    echo "用法: ./smart-recommend.sh <当前任务描述>"
    echo "示例: ./smart-recommend.sh '编写 FIFO 模块'"
    exit 1
fi

echo "=== 智能推荐: $TASK ==="
echo ""

# 1. 任务分析
echo "🔍 任务分析:"
# 提取关键词
KEYWORDS=$(echo "$TASK" | tr ' ' '\n' | head -5)
echo "  关键词: $KEYWORDS"
echo ""

# 2. 相关记忆推荐
echo "📚 相关记忆推荐:"
for keyword in $KEYWORDS; do
    echo "  [$keyword]"
    grep -r -l "$keyword" "$MEMORY_DIR" 2>/dev/null | head -3
done
echo ""

# 3. 相关知识推荐
echo "📖 相关知识推荐:"
for keyword in $KEYWORDS; do
    echo "  [$keyword]"
    grep -r -l "$keyword" "$KB_DIR" 2>/dev/null | grep -v source | head -3
done
echo ""

# 4. 相关模式推荐
echo "🎯 相关模式推荐:"
grep -r -l "$TASK" "$MEMORY_DIR/learnings" 2>/dev/null | head -5
echo ""

# 5. 历史经验推荐
echo "📜 历史经验推荐:"
find "$MEMORY_DIR/work" -name "*.md" ! -name "TEMPLATE.md" -mtime -30 2>/dev/null | head -5
echo ""

echo "=== 推荐完成 ==="
