#!/bin/bash
# 通用路径配置 (v4.0)
# 被 engine/scripts/ 下的脚本 source，解析路径 = engine/scripts/../config.path.sh = engine/config.path.sh
# 所有路径适配 v4.0 目录结构

# Claude Code 根目录
export CLAUDE_ROOT="${HOME}/.claude"

# 记忆目录
export MEMORY_DIR="${CLAUDE_ROOT}/memory"

# 知识库目录
export KB_DIR="${CLAUDE_ROOT}/knowledge/primary"

# 脚本目录 (v4.0: engine/scripts/)
export SCRIPTS_DIR="${CLAUDE_ROOT}/engine/scripts"

# 参考文档目录 (v4.0: knowledge/references/)
export REFERENCES_DIR="${CLAUDE_ROOT}/knowledge/references"

# 插件目录 (v4.0: var/plugins/)
export PLUGINS_DIR="${CLAUDE_ROOT}/var/plugins"

# 引擎配置 (新增 v4.0)
export ENGINE_DIR="${CLAUDE_ROOT}/engine"
export ENGINE_HOOKS_DIR="${ENGINE_DIR}/hooks"
export ENGINE_SCRIPTS_DIR="${ENGINE_DIR}/scripts"
