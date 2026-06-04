#!/bin/bash
# 记忆清理脚本 v2
# 用途: 基于文件名日期判断过期记忆，自动建议归档
# 用法: ./memory-cleanup.sh [--dry-run|--archive]
#   --dry-run   只列出可归档文件（默认）
#   --archive   执行归档操作

set -euo pipefail

MEMORY_DIR="$(cd "$(dirname "$0")/../memory" && pwd)"
ARCHIVE_DIR="$MEMORY_DIR/archive"
TODAY=$(date +%s)

# 各类型寿命（天）
WORK_LIFETIME=14
ERROR_LIFETIME=90
PROJECT_LIFETIME=30

echo "========================================="
echo "  记忆系统清理 v2"
echo "  记忆目录: $MEMORY_DIR"
echo "========================================="
echo ""

total=0
expired=0
archivable=""

# 从文件名提取第1个 YYYY-MM-DD
extract_date() {
    local fname
    fname=$(basename "$1")
    echo "$fname" | sed -n 's/^\([0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\).*/\1/p'
}

# 检查 status 是否为完成
check_done() {
    grep -qiE "status:.*完成|status:.*completed" "$1" 2>/dev/null && return 0
    return 1
}

# 计算文件日期距今的天数
days_old() {
    local file_date=$1
    local file_ts
    case "$(uname -s)" in
        Darwin)
            file_ts=$(date -j -f "%Y-%m-%d" "$file_date" +%s 2>/dev/null) || return 1
            ;;
        *)
            file_ts=$(date -d "$file_date" +%s 2>/dev/null) || return 1
            ;;
    esac
    echo $(( (TODAY - file_ts) / 86400 ))
}

echo "=== 1 work/ 工作记忆（寿命 ${WORK_LIFETIME}天）==="
for f in "$MEMORY_DIR"/work/*.md; do
    [ ! -f "$f" ] && continue
    [ "$(basename "$f")" = "TEMPLATE.md" ] && continue
    total=$((total + 1))

    d=$(extract_date "$f")
    name=$(basename "$f")
    [ -z "$d" ] && { echo "  ? 无日期: $name"; continue; }

    age=$(days_old "$d") || { echo "  ! 日期解析失败: $name"; continue; }

    if check_done "$f"; then
        if [ "$age" -gt "$WORK_LIFETIME" ]; then
            echo "  > 可归档: $name（完成 ${age}天前）"
            archivable="$archivable $f"
            expired=$((expired + 1))
        else
            echo "  v 活跃: $name（完成 ${age}天前，还有 $((WORK_LIFETIME - age))天）"
        fi
    else
        if [ "$age" -gt "$((WORK_LIFETIME * 2))" ]; then
            echo "  ! 长期未完成: $name（${age}天前，请确认是否需要）"
        else
            echo "  o 进行中: $name（${age}天前）"
        fi
    fi
done

echo ""
echo "=== 2 errors/ 错误记录（寿命 ${ERROR_LIFETIME}天）==="
for f in "$MEMORY_DIR"/errors/*.md; do
    [ ! -f "$f" ] && continue
    [ "$(basename "$f")" = "ERROR_TEMPLATE.md" ] && continue
    total=$((total + 1))

    d=$(extract_date "$f")
    name=$(basename "$f")
    [ -z "$d" ] && { echo "  ? 无日期: $name"; continue; }

    age=$(days_old "$d") || continue

    if [ "$age" -gt "$ERROR_LIFETIME" ]; then
        echo "  > 可归档: $name（${age}天前）"
        archivable="$archivable $f"
        expired=$((expired + 1))
    else
        echo "  o 有效: $name（${age}天前）"
    fi
done

echo ""
echo "=== 3 projects/（寿命 ${PROJECT_LIFETIME}天）==="
for f in "$MEMORY_DIR"/projects/*.md; do
    [ ! -f "$f" ] && continue
    total=$((total + 1))

    d=$(extract_date "$f")
    name=$(basename "$f")
    [ -z "$d" ] && { echo "  ? 无日期: $name"; continue; }

    age=$(days_old "$d") || continue

    if check_done "$f" && [ "$age" -gt "$PROJECT_LIFETIME" ]; then
        echo "  > 可归档: $name"
        archivable="$archivable $f"
        expired=$((expired + 1))
    else
        echo "  o $name（${age}天前）"
    fi
done

echo ""
echo "========================================="
echo "统计: 总计 $total 文件，$expired 可归档"
echo "========================================="
echo ""

if [ -n "$archivable" ]; then
    if [ "${1:-}" = "--archive" ]; then
        echo ">>> 执行归档..."
        mkdir -p "$ARCHIVE_DIR"
        for f in $archivable; do
            target="$ARCHIVE_DIR/$(basename "$f")"
            mv -v "$f" "$target"
        done
        echo "完成。"
    else
        echo "建议操作: 执行 $0 --archive 可归档 $expired 个文件"
        echo "（当前为 --dry-run 预览模式）"
    fi
else
    echo "无需清理，所有记忆均在有效期内。"
fi

echo ""
echo "=== 健康检查 ==="
work_count=$(find "$MEMORY_DIR/work" -name "*.md" -not -name "TEMPLATE.md" | wc -l)
error_count=$(find "$MEMORY_DIR/errors" -name "*.md" -not -name "ERROR_TEMPLATE.md" | wc -l)
total_count=$(find "$MEMORY_DIR" -name "*.md" -not -path "*/archive/*" -not -name "TEMPLATE.md" -not -name "ERROR_TEMPLATE.md" -not -name "MEMORY.md" -not -name "MEMORY_RULES.md" -not -name "links.md" | wc -l)

echo "  work/: $work_count / errors: $error_count / 活跃记忆总数: $total_count"
if [ "$total_count" -gt 30 ]; then
    echo "  ! 超过警戒线(30)，建议清理"
elif [ "$work_count" -gt 5 ]; then
    echo "  ! work/ 超过警戒线(5)"
else
    echo "  + 健康状态良好"
fi
echo ""
echo "========================================="
