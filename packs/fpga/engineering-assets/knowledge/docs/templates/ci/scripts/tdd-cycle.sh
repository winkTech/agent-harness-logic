#!/bin/bash
# tdd-cycle.sh - TDD 循环管理脚本
# 用法: ./tdd-cycle.sh <command> [args]
# 命令: start, red, green, refactor, done, status, verify-*

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 状态文件
TDD_STATE_FILE=".tdd-state"
TDD_LOG_FILE=".tdd-log"

# 函数定义
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 初始化状态
init_state() {
    if [ ! -f "$TDD_STATE_FILE" ]; then
        echo "PHASE=none" > "$TDD_STATE_FILE"
        echo "CYCLE=0" >> "$TDD_STATE_FILE"
        echo "FEATURE=" >> "$TDD_STATE_FILE"
        echo "START_TIME=$(date +%s)" >> "$TDD_STATE_FILE"
    fi
}

# 读取状态
read_state() {
    if [ -f "$TDD_STATE_FILE" ]; then
        source "$TDD_STATE_FILE"
    else
        PHASE="none"
        CYCLE=0
        FEATURE=""
    fi
}

# 保存状态
save_state() {
    echo "PHASE=$PHASE" > "$TDD_STATE_FILE"
    echo "CYCLE=$CYCLE" >> "$TDD_STATE_FILE"
    echo "FEATURE=$FEATURE" >> "$TDD_STATE_FILE"
    echo "START_TIME=$START_TIME" >> "$TDD_STATE_FILE"
    echo "LAST_UPDATE=$(date +%s)" >> "$TDD_STATE_FILE"
}

# 记录日志
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$TDD_LOG_FILE"
}

# 运行测试
run_tests() {
    local test_path="${1:-tests/}"
    local verbose="${2:---tb=short}"

    if command -v pytest &> /dev/null; then
        pytest "$test_path" $verbose
    else
        python -m pytest "$test_path" $verbose
    fi
}

# 运行测试并检查覆盖率
run_tests_with_coverage() {
    local test_path="${1:-tests/}"
    local src_path="${2:-src}"
    local min_coverage="${3:-80}"

    pytest "$test_path" \
        --cov="$src_path" \
        --cov-report=term-missing \
        --cov-fail-under="$min_coverage" \
        --tb=short
}

# 代码检查
run_lint() {
    if command -v ruff &> /dev/null; then
        ruff check src/ tests/
    elif command -v flake8 &> /dev/null; then
        flake8 src/ tests/
    else
        warn "未找到 linter，跳过检查"
    fi
}

# 命令: start - 开始新的 TDD 功能
cmd_start() {
    local feature_name="$1"

    if [ -z "$feature_name" ]; then
        error "请提供功能名称: ./tdd-cycle.sh start <功能名>"
        exit 1
    fi

    init_state
    read_state

    if [ "$PHASE" != "none" ]; then
        warn "已有进行中的 TDD 循环: $FEATURE"
        echo "使用 './tdd-cycle.sh done' 完成当前循环"
        exit 1
    fi

    PHASE="ready"
    CYCLE=1
    FEATURE="$feature_name"
    START_TIME=$(date +%s)

    save_state

    info "开始 TDD 循环: $FEATURE"
    info "当前阶段: RED (准备写失败测试)"
    log "START: $FEATURE"

    echo ""
    echo "下一步:"
    echo "  1. ./tdd-cycle.sh red      # 进入 RED 阶段"
    echo "  2. 编写失败的测试"
    echo "  3. ./tdd-cycle.sh verify-red  # 验证测试失败"
}

# 命令: red - 进入 RED 阶段
cmd_red() {
    read_state

    if [ "$PHASE" = "none" ]; then
        error "没有进行中的 TDD 循环"
        echo "使用 './tdd-cycle.sh start <功能名>' 开始新循环"
        exit 1
    fi

    PHASE="red"
    save_state

    info "进入 RED 阶段 - Cycle $CYCLE"
    log "RED: Cycle $CYCLE"

    echo ""
    echo "请编写失败的测试:"
    echo "  1. 创建/编辑 tests/test_<功能>.py"
    echo "  2. 编写测试用例（此时应该失败）"
    echo "  3. 运行 './tdd-cycle.sh verify-red' 验证"
}

# 命令: verify-red - 验证测试失败
cmd_verify_red() {
    read_state

    if [ "$PHASE" != "red" ]; then
        error "当前不在 RED 阶段"
        exit 1
    fi

    info "验证测试失败..."

    if run_tests "tests/" "--tb=line -q" 2>/dev/null; then
        error "测试通过了！RED 阶段要求测试失败"
        echo "请确保:"
        echo "  1. 测试针对的是未实现的功能"
        echo "  2. 测试代码正确"
        exit 1
    else
        success "测试按预期失败 ✓"
        log "VERIFY_RED: PASS (test failed as expected)"
        echo ""
        echo "下一步: ./tdd-cycle.sh green"
    fi
}

# 命令: green - 进入 GREEN 阶段
cmd_green() {
    read_state

    if [ "$PHASE" != "red" ]; then
        error "请先完成 RED 阶段"
        exit 1
    fi

    PHASE="green"
    save_state

    info "进入 GREEN 阶段 - Cycle $CYCLE"
    log "GREEN: Cycle $CYCLE"

    echo ""
    echo "请编写最小实现代码:"
    echo "  1. 编辑 src/<模块>.py"
    echo "  2. 只写刚好让测试通过的代码"
    echo "  3. 运行 './tdd-cycle.sh verify-green' 验证"
}

# 命令: verify-green - 验证测试通过
cmd_verify_green() {
    read_state

    if [ "$PHASE" != "green" ]; then
        error "当前不在 GREEN 阶段"
        exit 1
    fi

    info "验证测试通过..."

    if run_tests "tests/" "--tb=short -q"; then
        success "所有测试通过 ✓"
        log "VERIFY_GREEN: PASS"
        echo ""
        echo "下一步: ./tdd-cycle.sh refactor"
    else
        error "测试未通过"
        echo "请修复代码后重试"
        exit 1
    fi
}

# 命令: refactor - 进入 REFACTOR 阶段
cmd_refactor() {
    read_state

    if [ "$PHASE" != "green" ]; then
        error "请先完成 GREEN 阶段"
        exit 1
    fi

    PHASE="refactor"
    save_state

    info "进入 REFACTOR 阶段 - Cycle $CYCLE"
    log "REFACTOR: Cycle $CYCLE"

    echo ""
    echo "请重构代码:"
    echo "  1. 优化代码结构"
    echo "  2. 消除重复"
    echo "  3. 改善命名"
    echo "  4. 运行 './tdd-cycle.sh verify-refactor' 验证"
}

# 命令: verify-refactor - 验证重构后测试仍通过
cmd_verify_refactor() {
    read_state

    if [ "$PHASE" != "refactor" ]; then
        error "当前不在 REFACTOR 阶段"
        exit 1
    fi

    info "验证重构后测试仍通过..."

    # 运行测试
    if ! run_tests "tests/" "--tb=short"; then
        error "重构后测试失败"
        echo "请撤销重构或修复问题"
        exit 1
    fi

    # 代码检查
    if ! run_lint; then
        warn "代码风格有问题，请修复"
    fi

    success "重构验证通过 ✓"
    log "VERIFY_REFACTOR: PASS"

    echo ""
    echo "下一步: ./tdd-cycle.sh done"
}

# 命令: done - 完成当前循环
cmd_done() {
    read_state

    if [ "$PHASE" = "none" ]; then
        error "没有进行中的 TDD 循环"
        exit 1
    fi

    # 最终验证
    info "最终验证..."

    if ! run_tests "tests/" "--tb=short"; then
        error "最终验证失败"
        exit 1
    fi

    local end_time=$(date +%s)
    local duration=$(( end_time - START_TIME ))

    success "TDD 循环 $CYCLE 完成!"
    log "DONE: Cycle $CYCLE, Duration: ${duration}s"

    echo ""
    echo "════════════════════════════════════════"
    echo "  功能: $FEATURE"
    echo "  循环: $CYCLE"
    echo "  耗时: ${duration}秒"
    echo "════════════════════════════════════════"
    echo ""
    echo "下一步:"
    echo "  1. git add <相关文件>"
    echo "  2. git commit -m 'feat(<模块>): <描述> [TDD cycle $CYCLE]'"
    echo "  3. 继续下一个循环: ./tdd-cycle.sh red"

    # 重置状态
    CYCLE=$(( CYCLE + 1 ))
    PHASE="ready"
    save_state
}

# 命令: status - 查看状态
cmd_status() {
    read_state

    if [ "$PHASE" = "none" ]; then
        info "当前没有进行中的 TDD 循环"
        return
    fi

    echo ""
    echo "════════════════════════════════════════"
    echo "  TDD 状态"
    echo "════════════════════════════════════════"
    echo "  功能: $FEATURE"
    echo "  循环: $CYCLE"
    echo "  阶段: $PHASE"
    echo "════════════════════════════════════════"

    # 显示阶段指示器
    echo ""
    case "$PHASE" in
        ready)
            echo "  [ ] RED ──────── [ ] GREEN ──────── [ ] REFACTOR"
            echo "  ▲"
            echo "  准备开始"
            ;;
        red)
            echo "  [●] RED ──────── [ ] GREEN ──────── [ ] REFACTOR"
            echo "  ▲"
            echo "  编写失败测试"
            ;;
        green)
            echo "  [✓] RED ──────── [●] GREEN ──────── [ ] REFACTOR"
            echo "                 ▲"
            echo "                 编写最小实现"
            ;;
        refactor)
            echo "  [✓] RED ──────── [✓] GREEN ──────── [●] REFACTOR"
            echo "                                   ▲"
            echo "                                   优化代码"
            ;;
    esac
    echo ""
}

# 命令: reset - 重置状态
cmd_reset() {
    rm -f "$TDD_STATE_FILE" "$TDD_LOG_FILE"
    success "TDD 状态已重置"
}

# 命令: log - 查看日志
cmd_log() {
    if [ -f "$TDD_LOG_FILE" ]; then
        cat "$TDD_LOG_FILE"
    else
        info "暂无日志"
    fi
}

# 显示帮助
show_help() {
    echo "TDD 循环管理脚本"
    echo ""
    echo "用法: ./tdd-cycle.sh <command> [args]"
    echo ""
    echo "命令:"
    echo "  start <功能名>     开始新的 TDD 循环"
    echo "  red                进入 RED 阶段"
    echo "  verify-red         验证测试失败"
    echo "  green              进入 GREEN 阶段"
    echo "  verify-green       验证测试通过"
    echo "  refactor           进入 REFACTOR 阶段"
    echo "  verify-refactor    验证重构后测试仍通过"
    echo "  done               完成当前循环"
    echo "  status             查看当前状态"
    echo "  log                查看 TDD 日志"
    echo "  reset              重置所有状态"
    echo "  help               显示此帮助"
    echo ""
    echo "示例:"
    echo "  ./tdd-cycle.sh start '用户认证'"
    echo "  ./tdd-cycle.sh red"
    echo "  # 编写测试..."
    echo "  ./tdd-cycle.sh verify-red"
    echo "  ./tdd-cycle.sh green"
    echo "  # 编写代码..."
    echo "  ./tdd-cycle.sh verify-green"
    echo "  ./tdd-cycle.sh refactor"
    echo "  # 重构代码..."
    echo "  ./tdd-cycle.sh verify-refactor"
    echo "  ./tdd-cycle.sh done"
}

# 主函数
main() {
    local command="${1:-help}"
    shift || true

    case "$command" in
        start)      cmd_start "$@" ;;
        red)        cmd_red ;;
        verify-red) cmd_verify_red ;;
        green)      cmd_green ;;
        verify-green) cmd_verify_green ;;
        refactor)   cmd_refactor ;;
        verify-refactor) cmd_verify_refactor ;;
        done)       cmd_done ;;
        status)     cmd_status ;;
        log)        cmd_log ;;
        reset)      cmd_reset ;;
        help|--help|-h) show_help ;;
        *)
            error "未知命令: $command"
            echo "使用 './tdd-cycle.sh help' 查看帮助"
            exit 1
            ;;
    esac
}

main "$@"
