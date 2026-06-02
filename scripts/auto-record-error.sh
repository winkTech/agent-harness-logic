#!/bin/bash
# 自动记录错误脚本
# 用途：自动创建错误记录，提取教训

ERROR_TYPE=$1
ERROR_DESC=$2
SOLUTION=$3

MEMORY_DIR="C:/Users/Lihan/.claude/memory"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H-%M)

if [ -z "$ERROR_TYPE" ] || [ -z "$ERROR_DESC" ]; then
    echo "用法: ./auto-record-error.sh <错误类型> <错误描述> [解决方案]"
    echo "示例: ./auto-record-error.sh 'hook误判' 'GateGuard阻止正常操作' '添加排除目录'"
    exit 1
fi

# 创建错误记录文件
ERROR_FILE="$MEMORY_DIR/errors/${DATE}-${ERROR_TYPE}.md"

cat > "$ERROR_FILE" << EOF
---
date: $DATE
time: $TIME
type: error
status: resolved
severity: medium
---

# 错误记录: $ERROR_TYPE

## 错误描述
$ERROR_DESC

## 错误时间
$DATE $TIME

## 解决方案
${SOLUTION:-"待补充"}

## 根本原因
[待分析]

## 经验教训
[待提取]

## 避免规则
[待建立]

## 相关记忆
- [ ] 检查是否有关联错误
- [ ] 更新相关知识文档
EOF

echo "✅ 错误记录已创建: $ERROR_FILE"

# 提取教训函数
extract_lessons() {
    local error_file=$1
    local lessons_file="$MEMORY_DIR/learnings/LESSONS.md"

    # 提取错误类型和解决方案
    local error_type=$(grep -A1 "## 错误描述" "$error_file" | tail -1)
    local solution=$(grep -A1 "## 解决方案" "$error_file" | tail -1)

    # 添加到 LESSONS.md
    if [ ! -f "$lessons_file" ]; then
        cat > "$lessons_file" << EOF
# 经验教训汇总

## 错误教训

| 日期 | 错误类型 | 教训 | 避免规则 |
|------|----------|------|----------|
EOF
    fi

    # 提取教训
    local lesson="避免 $error_type: $solution"
    local rule="遇到 $error_type 时，$solution"

    # 添加到表格
    echo "| $DATE | $error_type | $lesson | $rule |" >> "$lessons_file"

    echo "✅ 教训已提取到: $lessons_file"
}

# 如果有解决方案，提取教训
if [ -n "$SOLUTION" ]; then
    extract_lessons "$ERROR_FILE"
fi
