#!/bin/bash
# new-project.sh - 项目初始化脚本
# 用法: ./new-project.sh <项目名> [类型]
# 类型: fpga (默认), python, matlab, mixed

set -e

PROJECT_NAME="$1"
PROJECT_TYPE="${2:-fpga}"

if [ -z "$PROJECT_NAME" ]; then
    echo "用法: $0 <项目名> [类型]"
    echo "类型: fpga (默认), python, matlab, mixed"
    exit 1
fi

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# 创建项目根目录
mkdir -p "$PROJECT_NAME"
cd "$PROJECT_NAME"

info "创建项目: $PROJECT_NAME (类型: $PROJECT_TYPE)"

# 创建基础目录结构
mkdir -p prj/00_comm
mkdir -p prj/06_doc

# 根据项目类型创建目录
case "$PROJECT_TYPE" in
    fpga)
        info "创建 FPGA 项目结构"
        mkdir -p prj/01_src/00_hdl
        mkdir -p prj/01_src/01_ip
        mkdir -p prj/02_sim
        mkdir -p prj/03_xdc
        mkdir -p prj/04_prj
        mkdir -p prj/05_bin
        ;;
    python)
        info "创建 Python 项目结构"
        mkdir -p prj/08_py
        ;;
    matlab)
        info "创建 MATLAB 项目结构"
        mkdir -p prj/07_mat/00_fx
        mkdir -p prj/07_mat/01_conf
        mkdir -p prj/07_mat/02_script
        ;;
    mixed)
        info "创建混合项目结构"
        mkdir -p prj/01_src/00_hdl
        mkdir -p prj/01_src/01_ip
        mkdir -p prj/02_sim
        mkdir -p prj/03_xdc
        mkdir -p prj/04_prj
        mkdir -p prj/05_bin
        mkdir -p prj/07_mat/00_fx
        mkdir -p prj/07_mat/01_conf
        mkdir -p prj/07_mat/02_script
        mkdir -p prj/08_py
        ;;
    *)
        warn "未知类型: $PROJECT_TYPE，使用默认结构"
        ;;
esac

# 初始化 Git
info "初始化 Git 仓库"
git init
git checkout -b main

# 创建 .gitignore
cat > .gitignore << 'EOF'
# FPGA
*.vcd
*.vcd.lxt
*.wlf
transcript
vsim.wlf
work/
*.td_ip
*.td_impl
*.td_tcl

# Modelsim
transcript
vsim.dump
*.wlftmp

# Python
__pycache__/
*.pyc
.venv/
*.pyo

# MATLAB
*.asv
slprj/

# 仿真输出
*_sim/
wave_*.do

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
EOF

# 创建 CLAUDE.md
cat > CLAUDE.md << 'EOF'
# Claude Code Constraints

## 项目信息
- 项目名称: PROJECT_NAME
- 项目类型: PROJECT_TYPE

## 目录结构
- prj/00_comm    - 全局脚本和配置
- prj/01_src     - HDL 和 IP 源代码
- prj/02_sim     - 仿真 testbench 和测试数据
- prj/03_xdc     - 约束文件
- prj/04_prj     - 工程文件
- prj/05_bin     - 烧写文件
- prj/06_doc     - 项目文档
- prj/07_mat     - MATLAB 代码
- prj/08_py      - Python 程序

## 版本管理
- 遵循 GIT_RULE.md 规范
- commit 前必须通过 lint 检查
EOF

# 替换占位符
sed -i "s/PROJECT_NAME/$PROJECT_NAME/g" CLAUDE.md
sed -i "s/PROJECT_TYPE/$PROJECT_TYPE/g" CLAUDE.md

# 创建项目说明文件
cat > prj/06_doc/README.md << EOF
# $PROJECT_NAME

## 项目说明
[在此添加项目说明]

## 目录结构
- prj/00_comm/   - 全局脚本
- prj/01_src/    - 源代码
- prj/02_sim/    - 仿真文件
- prj/03_xdc/    - 约束文件
- prj/04_prj/    - 工程文件
- prj/05_bin/    - 烧写文件
- prj/06_doc/    - 文档

## 开发环境
- [列出工具版本]
EOF

info "项目初始化完成!"
info "下一步:"
info "  1. cd $PROJECT_NAME"
info "  2. 根据项目类型添加源代码"
info "  3. 配置 CI/CD (可选)"
