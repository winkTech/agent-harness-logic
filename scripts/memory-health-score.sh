#!/bin/bash
# ============================================================================
# 记忆健康评分脚本
# 用途: 扫描所有记忆文件，按 freshness/完整性/链接度 评分
# 用法:
#   ./scripts/memory-health-score.sh              # 全量评分
#   ./scripts/memory-health-score.sh --stale-only  # 只看低分项
#   ./scripts/memory-health-score.sh --rank        # 只输出排名表格
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MEMORY_DIR="$PROJECT_ROOT/memory"
NOW=$(date +%s)
STALE_DAYS=14
STALE_SECONDS=$((STALE_DAYS * 86400))

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

MODE="${1:-all}"

# ============================================================================
# 评分函数 (每项 0-25 分，最高 100)
# ============================================================================
score_file() {
    local f="$1"
    local score=0
    local reasons=""

    # 1. Freshness (25分)
    local mtime
    mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    local age=$((NOW - mtime))
    if [ $age -lt 86400 ]; then
        score=$((score + 25))
        reasons="$reasons freshness:25"
    elif [ $age -lt $((STALE_SECONDS)) ]; then
        score=$((score + 15))
        reasons="$reasons freshness:15"
    elif [ $age -lt $((STALE_SECONDS * 2)) ]; then
        score=$((score + 8))
        reasons="$reasons freshness:8"
    else
        score=$((score + 3))
        reasons="$reasons freshness:3"
    fi

    # 2. Frontmatter 完整性 (25分)
    local has_name=0 has_desc=0 has_type=0
    grep -q "^name:" "$f" 2>/dev/null && has_name=1
    grep -q "^description:" "$f" 2>/dev/null && has_desc=1
    grep -q "^metadata:" "$f" 2>/dev/null && has_type=1

    if [ $has_name -eq 1 ] && [ $has_desc -eq 1 ] && [ $has_type -eq 1 ]; then
        score=$((score + 25))
        reasons="$reasons frontmatter:25"
    elif [ $has_name -eq 1 ] && [ $has_desc -eq 1 ]; then
        score=$((score + 18))
        reasons="$reasons frontmatter:18"
    elif [ $has_name -eq 1 ]; then
        score=$((score + 10))
        reasons="$reasons frontmatter:10"
    else
        score=$((score + 0))
        reasons="$reasons frontmatter:0"
    fi

    # 3. 内容质量 (25分)
    local total_lines
    total_lines=$(wc -l < "$f")
    if [ "$total_lines" -gt 80 ]; then
        score=$((score + 25))
        reasons="$reasons content:25"
    elif [ "$total_lines" -gt 40 ]; then
        score=$((score + 18))
        reasons="$reasons content:18"
    elif [ "$total_lines" -gt 15 ]; then
        score=$((score + 10))
        reasons="$reasons content:10"
    else
        score=$((score + 5))
        reasons="$reasons content:5"
    fi

    # 4. 链接度 (25分) — 入链+出链
    local name
    name=$(grep "^name:" "$f" 2>/dev/null | sed 's/^name: //')
    local outgoing=0 incoming=0

    # 出链: 文件中 [[...]] 的数量
    outgoing=$(grep -c '\[\[.*\]\]' "$f" 2>/dev/null || true)

    # 入链: 其他文件引用此文件 name 的数量
    incoming=0
    if [ -n "$name" ]; then
        incoming=$(grep -r "\[\[$name\]\]" "$MEMORY_DIR" --include="*.md" 2>/dev/null | grep -v "$f" | wc -l || true)
    fi

    : "${outgoing:=0}"
    : "${incoming:=0}"
    local links=$((outgoing + incoming))
    if [ "$links" -gt 5 ]; then
        score=$((score + 25))
        reasons="$reasons links:25"
    elif [ "$links" -gt 2 ]; then
        score=$((score + 18))
        reasons="$reasons links:18"
    elif [ "$links" -gt 0 ]; then
        score=$((score + 10))
        reasons="$reasons links:10"
    else
        score=$((score + 0))
        reasons="$reasons links:0"
    fi

    echo "$score|$reasons"
}

# ============================================================================
# Main
# ============================================================================
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  记忆健康评分  |  $(date +%Y-%m-%d)${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo ""

results=()
total_score=0
file_count=0

while IFS= read -r -d '' f; do
    rel="${f#$PROJECT_ROOT/}"
    score_data=$(score_file "$f")
    score="${score_data%%|*}"
    reasons="${score_data#*|}"

    results+=("$score|$rel|$reasons")
    total_score=$((total_score + score))
    file_count=$((file_count + 1))
done < <(find "$MEMORY_DIR" -name "*.md" -type f -print0)

# 评分等级标签
grade_label() {
    s="$1"
    if [ "$s" -ge 85 ]; then echo "🟢 优秀"
    elif [ "$s" -ge 65 ]; then echo "🟡 良好"
    elif [ "$s" -ge 40 ]; then echo "🟠 需改进"
    else echo "🔴 需归档"; fi
}

case "$MODE" in
    --stale-only)
        echo -e "${YELLOW}=== 低分/需归档文件 (< 40分) ===${NC}"
        for r in "${results[@]}"; do
            score="${r%%|*}"
            if [ "$score" -lt 40 ]; then
                rel="${r#*|}"; rel="${rel%%|*}"
                grade=$(grade_label "$score")
                echo -e "  $grade  ($score) $rel"
            fi
        done
        ;;
    --rank)
        echo -e "${CYAN}=== 排名 ===${NC}"
        sorted=()
        while IFS= read -r line; do
            sorted+=("$line")
        done < <(printf '%s\n' "${results[@]}" | sort -t'|' -k1 -rn)
        i=1
        for r in "${sorted[@]}"; do
            score="${r%%|*}"
            rel="${r#*|}"; rel="${rel%%|*}"
            grade=$(grade_label "$score")
            printf "  %2d. %s  %3d  %s\n" $i "$grade" "$score" "$rel"
            i=$((i + 1))
        done
        ;;
    *)
        echo "文件总数: $file_count"
        echo "平均分: $((file_count > 0 ? total_score / file_count : 0))"
        echo ""
        echo -e "${CYAN}=== 详细评分 ===${NC}"
        sorted=()
        while IFS= read -r line; do
            sorted+=("$line")
        done < <(printf '%s\n' "${results[@]}" | sort -t'|' -k1 -rn)
        for r in "${sorted[@]}"; do
            score="${r%%|*}"
            rest="${r#*|}"
            rel="${rest%%|*}"
            reasons="${rest#*|}"
            grade=$(grade_label "$score")
            echo -e "  $grade  ($score) $rel"
            echo "           $reasons"
        done
        ;;
esac

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo "  健康摘要"
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"

# 统计分布
excellent=0; good=0; needs=0; stale=0
for r in "${results[@]}"; do
    s="${r%%|*}"
    if [ "$s" -ge 85 ]; then excellent=$((excellent+1))
    elif [ "$s" -ge 65 ]; then good=$((good+1))
    elif [ "$s" -ge 40 ]; then needs=$((needs+1))
    else stale=$((stale+1)); fi
done

echo "  🟢 优秀     $excellent 文件"
echo "  🟡 良好     $good 文件"
echo "  🟠 需改进   $needs 文件"
echo "  🔴 需归档   $stale 文件"
echo "  平均分: $((file_count > 0 ? total_score / file_count : 0))/100"
echo "  健康率: $((file_count > 0 ? (excellent + good) * 100 / file_count : 0))%"
