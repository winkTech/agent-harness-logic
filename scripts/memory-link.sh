#!/bin/bash
# 记忆关联脚本
# 用途：建立记忆之间的关联关系

source "$(dirname "$0")/../config.path.sh"
LINKS_FILE="$MEMORY_DIR/links.md"

if [ ! -f "$LINKS_FILE" ]; then
    cat > "$LINKS_FILE" << EOF
# 记忆关联图

> 最后更新: $(date +%Y-%m-%d)

---

## 关联关系

| 记忆 A | 关联类型 | 记忆 B | 说明 |
|--------|----------|--------|------|
EOF
fi

ACTION=$1
MEMORY_A=$2
MEMORY_B=$3
DESCRIPTION=$4

case $ACTION in
    "add")
        if [ -z "$MEMORY_A" ] || [ -z "$MEMORY_B" ]; then
            echo "用法: ./memory-link.sh add <记忆A> <记忆B> [描述]"
            echo "示例: ./memory-link.sh add '2026-06-01-新插件适配' '2026-06-02-知识库构建' '都是插件相关'"
            exit 1
        fi

        # 添加关联关系
        echo "| $MEMORY_A | 相关 | $MEMORY_B | ${DESCRIPTION:-无} |" >> "$LINKS_FILE"
        echo "✅ 关联已添加: $MEMORY_A ↔ $MEMORY_B"
        ;;

    "show")
        echo "=== 记忆关联图 ==="
        echo ""
        cat "$LINKS_FILE"
        ;;

    "find")
        if [ -z "$MEMORY_A" ]; then
            echo "用法: ./memory-link.sh find <关键词>"
            exit 1
        fi

        echo "=== 查找关联: $MEMORY_A ==="
        echo ""
        grep -i "$MEMORY_A" "$LINKS_FILE" 2>/dev/null
        ;;

    *)
        echo "用法: ./memory-link.sh <action> [参数]"
        echo ""
        echo "可用 actions:"
        echo "  add <记忆A> <记忆B> [描述] - 添加关联"
        echo "  show                         - 显示所有关联"
        echo "  find <关键词>                - 查找关联"
        ;;
esac
