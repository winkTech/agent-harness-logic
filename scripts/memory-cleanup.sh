#!/bin/bash
# 记忆清理脚本
# 用途：清理过期记忆，保持记忆系统健康

source "$(dirname "$0")/../config.path.sh"
DAYSOLD=30

echo "=== 记忆系统清理 ==="
echo ""

# 1. 统计当前记忆
echo "📊 当前记忆统计:"
TOTAL=$(find "$MEMORY_DIR" -name "*.md" 2>/dev/null | wc -l)
echo "  总文件数: $TOTAL"

# 2. 按类型统计
echo "  工作记忆: $(find "$MEMORY_DIR/work" -name "*.md" 2>/dev/null | wc -l)"
echo "  错误记录: $(find "$MEMORY_DIR/errors" -name "*.md" 2>/dev/null | wc -l)"
echo "  学习总结: $(find "$MEMORY_DIR/learnings" -name "*.md" 2>/dev/null | wc -l)"
echo ""

# 3. 查找过期文件
echo "🔍 查找 ${DAYSOLD} 天前的文件:"
OLD_FILES=$(find "$MEMORY_DIR" -name "*.md" -mtime +$DAYSOLD 2>/dev/null | wc -l)
echo "  过期文件数: $OLD_FILES"

if [ "$OLD_FILES" -gt 0 ]; then
    echo "  过期文件列表:"
    find "$MEMORY_DIR" -name "*.md" -mtime +$DAYSOLD 2>/dev/null | while IFS= read -r file; do
        echo "    - $(basename $file)"
    done
fi
echo ""

# 4. 清理过期文件（可选）
if [ "$OLD_FILES" -gt 0 ]; then
    echo "⚠️  发现 $OLD_FILES 个过期文件"
    echo "  使用以下命令清理:"
    echo "  find $MEMORY_DIR -name '*.md' -mtime +$DAYSOLD -delete"
    echo ""
fi

# 5. 检查记忆索引
echo "📋 检查记忆索引:"
if [ -f "$MEMORY_DIR/MEMORY.md" ]; then
    INDEX_LINES=$(wc -l < "$MEMORY_DIR/MEMORY.md")
    echo "  MEMORY.md 存在: $INDEX_LINES 行"
else
    echo "  MEMORY.md 不存在"
fi
echo ""

echo "=== 清理完成 ==="
