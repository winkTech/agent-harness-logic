#!/bin/bash
# 记忆积累触发器
# 用途：根据工作状态自动触发记忆记录

ACTION=$1
MEMORY_DIR="C:/Users/Lihan/.claude/memory"

case $ACTION in
    "work-start")
        echo "🚀 工作开始，创建工作记忆..."
        DATE=$(date +%Y-%m-%d)
        WORK_FILE="$MEMORY_DIR/work/${DATE}-工作记录.md"
        if [ ! -f "$WORK_FILE" ]; then
            cat > "$WORK_FILE" << EOF
---
date: $DATE
type: work
status: in_progress
---

# 工作记录: $DATE

## 今日任务
- [ ] 任务 1
- [ ] 任务 2

## 进度记录
[待更新]

## 遇到的问题
[待记录]

## 决策记录
[待记录]
EOF
            echo "✅ 工作记录已创建: $WORK_FILE"
        else
            echo "ℹ️  工作记录已存在: $WORK_FILE"
        fi
        ;;

    "work-end")
        echo "✅ 工作结束，更新工作记录..."
        DATE=$(date +%Y-%m-%d)
        WORK_FILE="$MEMORY_DIR/work/${DATE}-工作记录.md"
        if [ -f "$WORK_FILE" ]; then
            echo "" >> "$WORK_FILE"
            echo "## 完成时间" >> "$WORK_FILE"
            echo "$(date +%H:%M)" >> "$WORK_FILE"
            echo "✅ 工作记录已更新"
        else
            echo "⚠️  工作记录不存在"
        fi
        ;;

    "error-occurred")
        echo "❌ 发生错误，请记录..."
        echo "使用: ./auto-record-error.sh <错误类型> <错误描述> [解决方案]"
        ;;

    "success-completed")
        echo "🎉 任务完成，请记录..."
        echo "使用: ./auto-record-success.sh <成功类型> <成功描述> [可复用组件]"
        ;;

    "daily-review")
        echo "📋 每日回顾..."
        echo ""
        echo "今日工作记忆:"
        find "$MEMORY_DIR/work" -name "$(date +%Y-%m-%d)*" 2>/dev/null
        echo ""
        echo "今日错误记录:"
        find "$MEMORY_DIR/errors" -name "$(date +%Y-%m-%d)*" 2>/dev/null
        ;;

    "weekly-summary")
        echo "📊 每周总结..."
        echo ""
        echo "本周工作记忆:"
        find "$MEMORY_DIR/work" -mtime -7 2>/dev/null
        echo ""
        echo "本周错误记录:"
        find "$MEMORY_DIR/errors" -mtime -7 2>/dev/null
        echo ""
        echo "本周学习总结:"
        find "$MEMORY_DIR/learnings" -mtime -7 2>/dev/null
        ;;

    *)
        echo "用法: ./memory-trigger.sh <action>"
        echo ""
        echo "可用 actions:"
        echo "  work-start      - 工作开始，创建记录"
        echo "  work-end        - 工作结束，更新记录"
        echo "  error-occurred  - 发生错误，提示记录"
        echo "  success-completed - 任务完成，提示记录"
        echo "  daily-review    - 每日回顾"
        echo "  weekly-summary  - 每周总结"
        ;;
esac
