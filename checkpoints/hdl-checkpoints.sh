#!/bin/bash
# ============================================================================
# HDL Coding Workflow — 可执行检查点断言
# 来源: workflows/hdl-coding-workflow.md
# 用法: source hdl-checkpoints.sh && <function_name>
# ============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS() { echo -e "${GREEN}[PASS]${NC} $1"; }
FAIL() { echo -e "${RED}[FAIL]${NC} $1"; total_errors=$((total_errors+1)); }
WARN() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# ---------------------------------------------------------------------------
# Phase 0: 基础设施统一层
# ---------------------------------------------------------------------------
check_phase_0() {
  total_errors=0; echo "=== Phase 0 检查点 ==="
  [ -f Makefile ] && PASS "Makefile exists" || FAIL "Makefile missing"
  [ -f filelist.f ] && PASS "filelist.f exists" || FAIL "filelist.f missing"
  [ -f tb_filelist.f ] && PASS "tb_filelist.f exists" || WARN "tb_filelist.f missing (optional)"
  # 检查工具链实现文件
  toolchain=$(grep -E '^TOOLCHAIN' Makefile 2>/dev/null | head -1 | cut -d? -f2 || echo "")
  [ -n "$toolchain" ] && [ -f "toolchains/${toolchain}.mk" ] && PASS "toolchains/${toolchain}.mk found" || WARN "toolchain file not verified"
  # 编译通过
  make lint >/dev/null 2>&1 && PASS "make lint passed" || FAIL "make lint failed"
  make compile >/dev/null 2>&1 && PASS "make compile passed" || FAIL "make compile failed"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 1: Golden Reference Model
# ---------------------------------------------------------------------------
check_phase_1() {
  total_errors=0; echo "=== Phase 1 检查点 ==="
  # 检查 golden model 输出存在
  spec_file=".claude/state/hdl-coding/project-spec.json"
  if [ -f "$spec_file" ]; then
    expected_path=$(python3 -c "import json; print(json.load(open('$spec_file'))['golden_model']['expected_output_path'])" 2>/dev/null)
    [ -f "$expected_path" ] && PASS "Golden model output: $expected_path" || FAIL "Missing: $expected_path"
  else
    WARN "project-spec.json not found (check manually: golden model .hex/.bin exists?)"
    # 兜底检查
    ls golden_model/expected_output.* >/dev/null 2>&1 && PASS "golden_model/ dir OK" || FAIL "No golden model output found"
  fi
  [ -f "golden_model/test_vectors.hex" ] && PASS "test vectors found" || WARN "test_vectors.hex missing"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 2: Testbench-First
# ---------------------------------------------------------------------------
check_phase_2() {
  total_errors=0; echo "=== Phase 2 检查点 ==="
  # testbench 编译
  make compile >/dev/null 2>&1 && PASS "testbench compilation passed" || FAIL "testbench compilation failed"
  # SVA 编译检查
  grep -r "assert property" tb/ >/dev/null 2>&1 && PASS "SVA assertions found" || WARN "No SVA assertions detected"
  # LOG 宏使用检查
  grep -r '`LOG' tb/ >/dev/null 2>&1 && PASS "Structured LOG macros found" || WARN "No LOG macros detected"
  # 双通道日志检查
  grep -q '\$fwrite' tb/tb_top.sv 2>/dev/null && PASS "File logging (\$fwrite) configured" || WARN "\$fwrite not found in testbench"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 3: 增量式 RTL 编码
# ---------------------------------------------------------------------------
check_phase_3() {
  total_errors=0; echo "=== Phase 3 检查点 ==="
  # 最新的仿真结果
  latest_log=$(ls -t logs/*.log 2>/dev/null | head -1)
  if [ -n "$latest_log" ]; then
    grep -q "SIMULATION COMPLETE" "$latest_log" && PASS "Simulation completed: $latest_log" || FAIL "Simulation did not complete: $latest_log"
    errors=$(grep -c "FAIL" "$latest_log" 2>/dev/null || echo "0")
    [ "$errors" -eq 0 ] && PASS "No failures in $latest_log" || FAIL "$errors failure(s) in $latest_log"
  else
    WARN "No simulation logs found in logs/"
  fi
  # Layer 状态文件
  if [ -f ".claude/state/hdl-coding/layer-status.json" ]; then
    all_passed=$(python3 -c "
import json; s=json.load(open('.claude/state/hdl-coding/layer-status.json'))
all_pass=all(l['status']=='passed' for l in s['layers'])
print('PASS' if all_pass else 'FAIL')
" 2>/dev/null)
    [ "$all_passed" = "PASS" ] && PASS "All layers passed" || WARN "Some layers not yet passed"
  else
    WARN "layer-status.json not found"
  fi
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 4: 回归 + 覆盖率
# ---------------------------------------------------------------------------
check_phase_4() {
  total_errors=0; echo "=== Phase 4 检查点 ==="
  # 回归结果
  make regress >/dev/null 2>&1 && PASS "Regression passed" || FAIL "Regression failed"
  # 覆盖率
  coverage_report=$(ls -t logs/coverage*.txt 2>/dev/null | head -1)
  if [ -n "$coverage_report" ]; then
    mandatory=$(grep -oP 'mandatory:\s*\K[0-9.]+(?=%)' "$coverage_report" 2>/dev/null)
    if [ -n "$mandatory" ]; then
      [ "$(echo "$mandatory >= 100" | bc)" -eq 1 ] 2>/dev/null && PASS "Mandatory coverage: ${mandatory}%" || FAIL "Mandatory coverage ${mandatory}% < 100%"
    else
      WARN "Could not parse mandatory coverage from $coverage_report"
    fi
  else
    WARN "No coverage report found"
  fi
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 5: 代码审查
# ---------------------------------------------------------------------------
check_phase_5() {
  total_errors=0; echo "=== Phase 5 检查点 ==="
  # lint 必须全通过（门禁）
  make lint >/dev/null 2>&1 && PASS "make lint zero warnings" || FAIL "lint warnings exist"
  # 检查组合环路（用 Yosys 或简单启发式）
  grep -n 'assign.*=.*assign' rtl/*.sv 2>/dev/null && WARN "Potential combinational loop detected" || PASS "No obvious combinational loops"
  # 检查 SVA 启用
  grep -r 'assert property' rtl/ tb/ >/dev/null 2>&1 && PASS "Assertions enabled" || WARN "No assertions found"
  # 覆盖率报告
  [ -f "logs/coverage_report.txt" ] && PASS "Coverage report exists" || WARN "Coverage report missing"
  return $total_errors
}

# ---------------------------------------------------------------------------
# 全流程检查
# ---------------------------------------------------------------------------
check_all() {
  total_errors=0
  check_phase_0; check_phase_1; check_phase_2; check_phase_3; check_phase_4; check_phase_5
  echo "=== 总计: $total_errors 个检查点未通过 ==="
  return $total_errors
}

# 直接执行时运行全流程检查
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  check_all
fi
