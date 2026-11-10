#!/bin/bash
# ============================================================================
# Session 总结脚本
# 用途: 在会话结束时调用，自动创建/更新当日工作记忆
# 用法:
#   ./scripts/session-summary.sh "标题" "关键要点1|要点2|要点3"
#   ./scripts/session-summary.sh "LDPC 编码器调试" "修复双对角结构bug|通过 all tests|新增 3 个 testcase"
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/../../memory" ]; then PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -d "$SCRIPT_DIR/../memory" ]; then PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else PROJECT_ROOT="$HOME/.claude"; fi
MEMORY_WORK="$PROJECT_ROOT/memory/work"
TODAY=$(date +%Y-%m-%d)
NOW=$(date +%H:%M)
FILENAME="${TODAY}-session-summary.md"
FILEPATH="$MEMORY_WORK/$FILENAME"

TITLE="${1:-未命名会话}"
POINTS="${2:-}"

# ============================================================================
# 颜色
# ============================================================================
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================================================
# 创建或更新会话总结
# ============================================================================
if [ ! -f "$FILEPATH" ]; then
    # 创建新文件
    cat > "$FILEPATH" <<EOF
---
name: session-${TODAY}
description: ${TODAY} 会话总结 — ${TITLE}
date: ${TODAY}
status: 进行中
type: work
metadata:
  type: work
  usage:
    lastAccessed: ${TODAY}
    accessCount: 1
    quality: medium
---

# 会话总结: ${TODAY}

## 任务
- ${TITLE}

## 关键要点

EOF
    echo -e "${GREEN}已创建: ${FILEPATH}${NC}"
fi

if [ -n "$POINTS" ]; then
    IFS='|' read -ra ITEMS <<< "$POINTS"
    {
        echo ""
        echo "### $(date +%H:%M)"
        for item in "${ITEMS[@]}"; do
            echo "- ${item}"
        done
    } >> "$FILEPATH"
    echo -e "${GREEN}已追加 $POINTS${NC}"
fi

# 更新 lastAccessed
sed -i "s/lastAccessed: .*/lastAccessed: ${TODAY}/" "$FILEPATH" 2>/dev/null || true

# 显示当前摘要
echo ""
echo -e "${CYAN}══════════════════════════════════════${NC}"
echo -e "${CYAN}  Session 总结已保存${NC}"
echo -e "${CYAN}══════════════════════════════════════${NC}"
echo "  日期: $TODAY"
echo "  标题: $TITLE"
echo "  文件: $FILENAME"
echo ""
echo -e "${YELLOW}提示: 运行 health-score 查看记忆健康状态${NC}"
echo -e "  bash $SCRIPT_DIR/memory-health-score.sh --rank"
echo ""
