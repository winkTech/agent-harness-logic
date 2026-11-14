#!/bin/bash
# 通用路径配置 (v4.0)
# 被 engine/scripts/ 下的脚本 source，解析路径 = engine/scripts/../config.path.sh = engine/config.path.sh
# 所有路径适配 v4.0 目录结构

# Claude Code 代码根目录（本文件位于 <CLAUDE_ROOT>/engine/ 下，按自身位置推导）
export CLAUDE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 运行时状态根：默认与代码根同址（legacy in-place），HARNESS_STATE_DIR 可覆盖。
# 注意：shell 侧只实现「env 覆盖 + legacy 回落」两条，不探测 <homedir>/.logical-paradox/state.json
# 标记（那是 engine/scripts/lib/harness-state.cjs 的第 2 条规则）。迁移后 shell 侧需显式设 HARNESS_STATE_DIR。
export HARNESS_STATE_ROOT="${HARNESS_STATE_DIR:-$CLAUDE_ROOT}"
export VAR_DIR="$HARNESS_STATE_ROOT/var"
export WRIGHT_DIR="$HARNESS_STATE_ROOT/.wright"

# 记忆目录
export MEMORY_DIR="${CLAUDE_ROOT}/memory"

# 知识库目录
export KB_DIR="${CLAUDE_ROOT}/engineering-assets/knowledge/primary"

# 脚本目录 (v4.0: engine/scripts/)
export SCRIPTS_DIR="${CLAUDE_ROOT}/engine/scripts"

# 参考文档目录 (v4.0: engineering-assets/knowledge/references/)
export REFERENCES_DIR="${CLAUDE_ROOT}/engineering-assets/knowledge/references"

# 插件目录 (v4.0: var/plugins/ —— 状态根下)
export PLUGINS_DIR="$VAR_DIR/plugins"

# 引擎配置 (新增 v4.0)
export ENGINE_DIR="${CLAUDE_ROOT}/engine"
export ENGINE_HOOKS_DIR="${ENGINE_DIR}/hooks"
export ENGINE_SCRIPTS_DIR="${ENGINE_DIR}/scripts"
