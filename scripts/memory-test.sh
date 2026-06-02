#!/bin/bash
# 记忆系统测试脚本
# 用途：测试记忆系统的各项功能

source "$(dirname "$0")/../config.path.sh"
source "$(dirname "$0")/../config.path.sh"

echo "=== 记忆系统测试 ==="
echo ""

# 1. 测试目录结构
echo "📁 1. 测试目录结构..."
if [ -d "$MEMORY_DIR/work" ] && [ -d "$MEMORY_DIR/errors" ] && [ -d "$MEMORY_DIR/learnings" ]; then
    echo "  ✅ 目录结构完整"
else
    echo "  ❌ 目录结构不完整"
fi
echo ""

# 2. 测试模板文件
echo "📋 2. 测试模板文件..."
if [ -f "$MEMORY_DIR/work/TEMPLATE.md" ] && [ -f "$MEMORY_DIR/errors/ERROR_TEMPLATE.md" ]; then
    echo "  ✅ 模板文件存在"
else
    echo "  ❌ 模板文件缺失"
fi
echo ""

# 3. 测试索引文件
echo "📇 3. 测试索引文件..."
if [ -f "$MEMORY_DIR/MEMORY.md" ]; then
    LINES=$(wc -l < "$MEMORY_DIR/MEMORY.md")
    echo "  ✅ MEMORY.md 存在 ($LINES 行)"
else
    echo "  ❌ MEMORY.md 不存在"
fi
echo ""

# 4. 测试脚本文件
echo "📜 4. 测试脚本文件..."
SCRIPTS=("auto-record-error.sh" "auto-record-success.sh" "memory-retrieve.sh" "memory-trigger.sh" "memory-cleanup.sh" "memory-link.sh")
for script in "${SCRIPTS[@]}"; do
    if [ -f "$SCRIPTS_DIR/$script" ]; then
        echo "  ✅ $script 存在"
    else
        echo "  ❌ $script 缺失"
    fi
done
echo ""

# 5. 测试记忆数量
echo "📊 5. 测试记忆数量..."
WORK_COUNT=$(find "$MEMORY_DIR/work" -name "*.md" ! -name "TEMPLATE.md" 2>/dev/null | wc -l)
ERROR_COUNT=$(find "$MEMORY_DIR/errors" -name "*.md" ! -name "ERROR_TEMPLATE.md" 2>/dev/null | wc -l)
LEARNING_COUNT=$(find "$MEMORY_DIR/learnings" -name "*.md" ! -name "MEMORY_ACCUMULATION_PLAN.md" 2>/dev/null | wc -l)
TOTAL=$((WORK_COUNT + ERROR_COUNT + LEARNING_COUNT))
echo "  工作记忆: $WORK_COUNT 个"
echo "  错误记录: $ERROR_COUNT 个"
echo "  学习总结: $LEARNING_COUNT 个"
echo "  总记忆: $TOTAL 个"
echo ""

# 6. 测试关联文件
echo "🔗 6. 测试关联文件..."
if [ -f "$MEMORY_DIR/links.md" ]; then
    LINK_COUNT=$(grep -c "^|" "$MEMORY_DIR/links.md" 2>/dev/null || echo "0")
    echo "  ✅ links.md 存在 ($LINK_COUNT 个关联)"
else
    echo "  ⚠️  links.md 不存在"
fi
echo ""

echo "=== 测试完成 ==="
