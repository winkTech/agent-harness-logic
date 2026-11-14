#!/bin/bash
# run-tests.sh - 测试运行脚本

set -e

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查虚拟环境
check_venv() {
    if [ -z "$VIRTUAL_ENV" ]; then
        if [ -d ".venv" ]; then
            info "激活虚拟环境..."
            source .venv/bin/activate
        else
            error "未找到虚拟环境，请先运行 setup-env.sh"
            exit 1
        fi
    fi
}

# 运行 Python 测试
run_python_tests() {
    info "运行 Python 测试..."
    python -m pytest tests/ -v --tb=short
}

# 运行 Verilog 测试 (cocotb)
run_cocotb_tests() {
    if command -v iverilog &> /dev/null; then
        info "运行 cocotb 测试..."
        find . -name "Makefile" -path "*/tests/*" -exec make -C {} \;
    else
        info "跳过 cocotb 测试 (iverilog 未安装)"
    fi
}

# 代码质量检查
run_lint() {
    info "运行代码质量检查..."

    # Python
    if command -v ruff &> /dev/null; then
        info "运行 ruff..."
        find . -name "*.py" -not -path "./.venv/*" | xargs ruff check || true
    fi

    # Verilog
    if command -v iverilog &> /dev/null; then
        info "检查 Verilog 文件..."
        find . -name "*.v" -o -name "*.sv" | while read file; do
            iverilog -t null "$file" 2>&1 || true
        done
    fi
}

# 主函数
main() {
    info "开始测试..."

    check_venv
    run_python_tests
    run_cocotb_tests
    run_lint

    info "测试完成!"
}

main "$@"
