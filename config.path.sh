#!/bin/bash
# 通用路径配置
# 所有脚本引用此文件获取路径

# Claude Code 根目录
export CLAUDE_ROOT="${HOME}/.claude"

# 记忆目录
export MEMORY_DIR="${CLAUDE_ROOT}/memory"

# 知识库目录
export KB_DIR="${CLAUDE_ROOT}/knowledge/primary"

# 脚本目录
export SCRIPTS_DIR="${CLAUDE_ROOT}/scripts"

# 参考文档目录
export REFERENCES_DIR="${CLAUDE_ROOT}/references"

# 插件目录
export PLUGINS_DIR="${CLAUDE_ROOT}/plugins"

# 输出目录（开源用）
export OUTPUT_DIR="${HOME}/claude-agent-open-source"
