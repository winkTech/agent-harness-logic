#!/bin/bash
# 性能监控脚本
# 用途：检查 Agent 配置性能指标

echo "=== Agent 性能监控 ==="
echo ""

# 1. CLAUDE.md 大小
CLAUDE_LINES=$(wc -l < "${HOME}/.claude/CLAUDE.md" 2>/dev/null || echo "0")
echo "📊 CLAUDE.md: ${CLAUDE_LINES} 行"

# 2. references 文件数
REF_COUNT=$(ls -1 "${HOME}/.claude/references/" 2>/dev/null | wc -l)
echo "📚 参考文档: ${REF_COUNT} 个"

# 3. 插件数量
PLUGIN_COUNT=$(grep -c "true" "${HOME}/.claude/settings.json" 2>/dev/null || echo "0")
echo "🔌 已启用插件: ${PLUGIN_COUNT} 个"

# 4. 插件缓存大小
CACHE_SIZE=$(du -sh "${HOME}/.claude/plugins/cache/" 2>/dev/null | cut -f1 || echo "未知")
echo "💾 插件缓存: ${CACHE_SIZE}"

# 5. 记忆文件数
MEMORY_COUNT=$(find "${HOME}/.claude/memory/" -name "*.md" 2>/dev/null | wc -l)
echo "🧠 记忆文件: ${MEMORY_COUNT} 个"

# 6. 知识库文档数
KNOWLEDGE_COUNT=$(find "${HOME}/.claude/knowledge/primary" -name "*.md" 2>/dev/null | wc -l)
echo "📖 知识文档: ${KNOWLEDGE_COUNT} 个"

# 7. 源文档数
SOURCE_COUNT=$(find "${HOME}/.claude/knowledge/primary" -name "*-source.md" 2>/dev/null | wc -l)
echo "📄 源文档提取: ${SOURCE_COUNT} 个"

# 8. 原始 PDF 数
PDF_COUNT=$(find "${HOME}/.claude/knowledge/source" -name "*.pdf" 2>/dev/null | wc -l)
echo "📑 原始 PDF: ${PDF_COUNT} 个"

# 9. Git 提交数
COMMIT_COUNT=$(git -C "${HOME}/.claude" log --oneline 2>/dev/null | wc -l)
echo "📝 Git 提交: ${COMMIT_COUNT} 个"

# 10. 响应延迟估算（基于 CLAUDE.md 大小）
EST_DELAY=$((CLAUDE_LINES / 20))
echo "⏱️  预估启动延迟: ${EST_DELAY}ms"

echo ""
echo "=== 优化建议 ==="

# 检查是否需要优化
if [ "$CLAUDE_LINES" -gt 100 ]; then
    echo "⚠️  CLAUDE.md 超过 100 行，考虑精简"
fi

if [ "$PLUGIN_COUNT" -gt 10 ]; then
    echo "⚠️  插件超过 10 个，考虑精简"
fi

if [ "$REF_COUNT" -lt 5 ]; then
    echo "💡 可以添加更多参考文档"
fi

if [ "$KNOWLEDGE_COUNT" -lt 20 ]; then
    echo "💡 知识库文档较少，考虑补充"
fi

if [ "$EST_DELAY" -gt 100 ]; then
    echo "⚠️  启动延迟较高，考虑优化 CLAUDE.md"
fi

echo ""
echo "=== 完成 ==="
