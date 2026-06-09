#!/bin/bash
# 插件使用统计脚本
# 用途：统计插件使用情况，识别低频插件

echo "=== 插件使用统计 ==="
echo ""

# 1. 已安装插件列表
echo "📦 已安装插件："
grep -E '"[a-z-]+@[a-z-]+": true' "${HOME}/.claude/settings.json" | sed 's/.*"\([^"]*\)".*/- \1/' | sort
echo ""

# 2. 插件缓存大小
echo "💾 插件缓存大小："
du -sh "${HOME}/.claude/plugins/cache/"*/ 2>/dev/null | sort -rh | head -10
echo ""

# 3. 插件文件数量
echo "📁 插件文件数量："
for dir in "${HOME}/.claude/plugins/cache/"*/; do
    if [ -d "$dir" ]; then
        count=$(find "$dir" -type f 2>/dev/null | wc -l)
        echo "  $(basename $dir): $count 个文件"
    fi
done
echo ""

# 4. 最近修改的插件
echo "🕐 最近修改的插件："
find "${HOME}/.claude/plugins/cache/" -name "*.md" -mtime -7 2>/dev/null | head -10
echo ""

# 5. 插件启用状态
echo "✅ 插件启用状态："
cat "${HOME}/.claude/settings.json" | grep -E '"[a-z-]+@[a-z-]+":' | sed 's/.*"\([^"]*\)": \(true\|false\).*/- \1: \2/'
echo ""

echo "=== 完成 ==="
