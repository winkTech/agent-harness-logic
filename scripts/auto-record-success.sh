#!/bin/bash
# 自动记录成功经验脚本
# 用途：自动创建成功记录，提取模式

SUCCESS_TYPE=$1
SUCCESS_DESC=$2
REUSABLE=$3

MEMORY_DIR="C:/Users/Lihan/.claude/memory"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H-%M)

if [ -z "$SUCCESS_TYPE" ] || [ -z "$SUCCESS_DESC" ]; then
    echo "用法: ./auto-record-success.sh <成功类型> <成功描述> [可复用组件]"
    echo "示例: ./auto-record-success.sh '插件开发' '完成coding-tutor插件适配' '插件配置模板'"
    exit 1
fi

# 创建成功记录文件
SUCCESS_FILE="$MEMORY_DIR/work/${DATE}-${SUCCESS_TYPE}.md"

cat > "$SUCCESS_FILE" << EOF
---
date: $DATE
time: $TIME
type: work
status: completed
priority: medium
---

# 成功记录: $SUCCESS_TYPE

## 成功描述
$SUCCESS_DESC

## 完成时间
$DATE $TIME

## 关键决策
1. [决策 1]
2. [决策 2]

## 遇到的问题
1. [问题 1]
   - 解决方案: [方案]

## 可复用组件
${REUSABLE:-"待提取"}

## 成功模式
[待提取]

## 使用场景
[待定义]

## 相关记忆
- [ ] 检查是否有关联成功
- [ ] 更新相关知识文档
EOF

echo "✅ 成功记录已创建: $SUCCESS_FILE"

# 提取模式函数
extract_patterns() {
    local success_file=$1
    local patterns_file="$MEMORY_DIR/learnings/LESSONS.md"

    # 提取成功类型和描述
    local success_type=$(grep -A1 "## 成功描述" "$success_file" | tail -1)
    local reusable=$(grep -A1 "## 可复用组件" "$success_file" | tail -1)

    # 添加到 LESSONS.md
    if [ ! -f "$patterns_file" ]; then
        cat > "$patterns_file" << EOF
# 经验教训汇总

## 成功模式

| 日期 | 成功类型 | 模式 | 使用场景 |
|------|----------|------|----------|
EOF
    fi

    # 提取模式
    local pattern="复用 $success_type: $reusable"
    local scenario="遇到类似 $success_type 时"

    # 添加到表格
    echo "| $DATE | $success_type | $pattern | $scenario |" >> "$patterns_file"

    echo "✅ 模式已提取到: $patterns_file"
}

# 如果有可复用组件，提取模式
if [ -n "$REUSABLE" ]; then
    extract_patterns "$SUCCESS_FILE"
fi
