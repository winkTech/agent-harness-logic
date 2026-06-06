#!/bin/bash
# ============================================================================
# init-project.sh — FPGA 项目初始化脚手架
# 用法:
#   bash scripts/init-project.sh <项目名> [目标器件]
#   bash scripts/init-project.sh my_ofdm_project xc7k325tffg900-2
# ============================================================================
# 关联: cross-project-experience.md → "快速启动"
# ============================================================================

set -euo pipefail

# ── 颜色 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 参数 ────────────────────────────────────────────────────────────────────
PROJECT_NAME="${1:-}"
DEVICE="${2:-xc7k325tffg900-2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$PWD"  # 在当前目录下创建项目

if [ -z "$PROJECT_NAME" ]; then
    echo -e "${RED}用法: bash $0 <项目名> [目标器件]${NC}"
    echo "  示例: bash $0 my_ofdm_project"
    echo "  示例: bash $0 wifi_phy xczu28dr-ffvg1517-2-e"
    exit 1
fi

# ── 检查 ─────────────────────────────────────────────────────────────────────
if [ -d "$PROJECT_NAME" ]; then
    echo -e "${YELLOW}⚠️  目录已存在: $PROJECT_NAME/${NC}"
    echo "   使用已有目录继续，跳过 mkdir"
fi

echo -e "${CYAN}═══ 初始化 FPGA 项目: ${PROJECT_NAME} ═══${NC}"
echo "  目标器件: $DEVICE"
echo ""

# ── 创建目录结构 ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}创建目录结构...${NC}"

mkdir -p "$PROJECT_NAME/prj/00_comm"
mkdir -p "$PROJECT_NAME/prj/01_src/00_hdl/00_com"
mkdir -p "$PROJECT_NAME/prj/01_src/01_ip/00_clk"
mkdir -p "$PROJECT_NAME/prj/01_src/01_ip/01_mem"
mkdir -p "$PROJECT_NAME/prj/01_src/01_ip/02_dsp"
mkdir -p "$PROJECT_NAME/prj/01_src/01_ip/03_comm"
mkdir -p "$PROJECT_NAME/prj/02_sim"
mkdir -p "$PROJECT_NAME/prj/03_xdc"
mkdir -p "$PROJECT_NAME/prj/04_prj"
mkdir -p "$PROJECT_NAME/prj/05_bin"
mkdir -p "$PROJECT_NAME/prj/06_doc"
mkdir -p "$PROJECT_NAME/prj/07_mat/00_fx"
mkdir -p "$PROJECT_NAME/prj/07_mat/01_conf"
mkdir -p "$PROJECT_NAME/prj/07_mat/02_script"
mkdir -p "$PROJECT_NAME/prj/08_py/00_utils"
mkdir -p "$PROJECT_NAME/prj/08_py/01_sim"
mkdir -p "$PROJECT_NAME/prj/08_py/02_plot"
mkdir -p "$PROJECT_NAME/prj/08_py/03_test"

echo -e "${GREEN}  ✅ 目录结构已创建${NC}"

# ── .gitignore ───────────────────────────────────────────────────────────────
echo -e "${YELLOW}创建 .gitignore...${NC}"

cat > "$PROJECT_NAME/.gitignore" << 'GITIGNORE'
# Vivado 项目生成
*.xpr
*.runs/
*.cache/
*.hw/
*.ip_user_files/
*.sim/

# 临时文件
*.log
*.jou
*.str
*.pb
*.dcp

# 仿真输出
*.wdb
*.vcd
*.wlf

# Python
__pycache__/
*.pyc
.pytest_cache/

# MATLAB
*.asv
*.mex*

# OS
.DS_Store
Thumbs.db

# 比特流 (想追踪时注释掉)
*.bit
*.bin
GITIGNORE

echo -e "${GREEN}  ✅ .gitignore 已创建${NC}"

# ── README.md ────────────────────────────────────────────────────────────────
echo -e "${YELLOW}创建 README.md...${NC}"

cat > "$PROJECT_NAME/README.md" << EOF
# ${PROJECT_NAME}

## 项目简介
> [项目描述]

## 目标器件
- **FPGA**: ${DEVICE}
- **工具**: Vivado [版本]
- **仿真**: ModelSim / XSIM
- **MATLAB**: [版本]
- **Python**: [版本]

## 目录说明

| 目录 | 用途 |
|:-----|:------|
| \`prj/00_comm/\` | 全局脚本、配置文件 |
| \`prj/01_src/00_hdl/\` | HDL 源代码 (按模块) |
| \`prj/01_src/01_ip/\` | IP 核 (按功能分类) |
| \`prj/02_sim/\` | 仿真文件 (与模块同名) |
| \`prj/03_xdc/\` | 时序/管脚约束 |
| \`prj/04_prj/\` | Vivado 工程文件 |
| \`prj/05_bin/\` | 比特流 + 版本说明 |
| \`prj/06_doc/\` | 设计文档 |
| \`prj/07_mat/\` | MATLAB golden model |
| \`prj/08_py/\` | Python 工具 |

## 快速开始

\`\`\`bash
# 项目管理 (TODO: 按具体情况更新)
\`\`\`

---

_Created by init-project.sh | $(date +%Y-%m-%d)_
EOF

echo -e "${GREEN}  ✅ README.md 已创建${NC}"

# ── .claude 配置 ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}创建 .claude 配置...${NC}"

mkdir -p "$PROJECT_NAME/prj/.claude"

# ── 完成 ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}═══ 初始化完成 ═══${NC}"
echo -e "${GREEN}项目目录: ${PROJECT_NAME}/${NC}"
echo ""
echo -e "${YELLOW}下一步建议:${NC}"
echo "  1. cd $PROJECT_NAME"
echo "  2. git init && git add -A && git commit -m \"init: ${PROJECT_NAME}\""
echo "  3. 添加第一个模块: bash $SCRIPT_DIR/init-module.sh <模块名>"
echo "  4. 编辑 README.md 填写项目描述"
echo ""
echo -e "${YELLOW}目录结构:${NC}"
find "$PROJECT_NAME/prj" -type d | sort | head -30
echo ""
echo -e "${GREEN}项目初始化完成!${NC}"
