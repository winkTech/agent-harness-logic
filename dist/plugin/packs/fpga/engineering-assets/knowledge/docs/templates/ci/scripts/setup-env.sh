#!/bin/bash
# setup-env.sh - 本地环境设置脚本
# 自动创建虚拟环境并安装依赖

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# 检查 Python 版本
check_python() {
    if command -v python3 &> /dev/null; then
        PYTHON=python3
    elif command -v python &> /dev/null; then
        PYTHON=python
    else
        error "Python 未安装"
        exit 1
    fi

    info "使用 Python: $($PYTHON --version)"
}

# 创建虚拟环境
create_venv() {
    VENV_DIR=".venv"

    if [ -d "$VENV_DIR" ]; then
        warn "虚拟环境已存在: $VENV_DIR"
    else
        info "创建虚拟环境: $VENV_DIR"
        $PYTHON -m venv "$VENV_DIR"
    fi

    # 激活虚拟环境
    source "$VENV_DIR/bin/activate"
    info "虚拟环境已激活"
}

# 安装依赖
install_deps() {
    info "升级 pip..."
    pip install --upgrade pip

    if [ -f "requirements.txt" ]; then
        info "安装 requirements.txt 依赖..."
        pip install -r requirements.txt
    fi

    if [ -f "requirements/dev.txt" ]; then
        info "安装开发依赖..."
        pip install -r requirements/dev.txt
    fi
}

# 安装 Git hooks
setup_git_hooks() {
    if [ -d ".git" ]; then
        info "配置 Git hooks..."
        git config core.hooksPath .githooks
    fi
}

# 主函数
main() {
    info "开始环境设置..."

    check_python
    create_venv
    install_deps
    setup_git_hooks

    info "环境设置完成!"
    info "使用 'source .venv/bin/activate' 激活虚拟环境"
}

main "$@"
