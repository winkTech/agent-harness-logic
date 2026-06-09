#!/bin/bash
# ============================================================================
# HDL Coding Workflow — 可执行检查点断言（对齐 8-Phase 工作流）
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
  toolchain=$(grep -E '^TOOLCHAIN' Makefile 2>/dev/null | head -1 | grep -oP '(?<=\?=)\s*\S+' || echo "")
  [ -n "$toolchain" ] && [ -f "toolchains/${toolchain}.mk" ] && PASS "toolchains/${toolchain}.mk found" || WARN "toolchain file not verified"
  make lint >/dev/null 2>&1 && PASS "make lint passed" || FAIL "make lint failed"
  make compile >/dev/null 2>&1 && PASS "make compile passed" || FAIL "make compile failed"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 1: 算法分析与架构设计
# ---------------------------------------------------------------------------
check_phase_1() {
  total_errors=0; echo "=== Phase 1 检查点 ==="
  [ -f algorithm_spec.md ] && PASS "algorithm_spec.md exists" || WARN "algorithm_spec.md missing"
  ls 06_doc/architecture*.png 06_doc/architecture*.pdf 06_doc/architecture*.svg 2>/dev/null 1>&2 && \
    PASS "Architecture block diagram found" || WARN "Architecture diagram not found in 06_doc/"
  # 检查模块设计方案（至少有一个模块设计文档）
  ls docs/module_*.md 2>/dev/null 1>&2 && PASS "Module design docs found" || WARN "No module design docs in docs/"
  # 检查 golden model
  [ -d golden_model/src ] && PASS "golden_model/src exists" || FAIL "golden_model/src missing"
  [ -d golden_model/tests ] && PASS "golden_model/tests exists" || FAIL "golden_model/tests missing"
  # 测试向量
  ls vectors/*.hex vectors/*.bin 2>/dev/null 1>&2 && PASS "Test vectors found" || WARN "No test vectors in vectors/"
  # project-spec.json
  [ -f ".claude/state/hdl-coding/project-spec.json" ] && PASS "project-spec.json exists" || WARN "project-spec.json missing"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 2: 定点量化与资源评估
# ---------------------------------------------------------------------------
check_phase_2() {
  total_errors=0; echo "=== Phase 2 检查点 ==="
  [ -f fixed_point_report.md ] && PASS "fixed_point_report.md exists" || FAIL "fixed_point_report.md missing"
  [ -f resource_estimate.md ] && PASS "resource_estimate.md exists" || FAIL "resource_estimate.md missing"
  # 资源预算检查（若有超标标记则 WARN）
  grep -qi "超标\|over budget\|exceed" resource_estimate.md 2>/dev/null && \
    WARN "Resource estimate shows over budget — need to backtrack Phase 2 or Phase 1" || \
    PASS "No resource overage detected"
  # 量化误差报告
  grep -q "NMSE\|SNR\|SQNR" fixed_point_report.md 2>/dev/null && \
    PASS "Quantization metrics found" || WARN "No NMSE/SNR metrics in fixed_point_report.md"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 3: Testbench-First（自检框架 + SVA）
# ---------------------------------------------------------------------------
check_phase_3() {
  total_errors=0; echo "=== Phase 3 检查点 ==="
  make compile >/dev/null 2>&1 && PASS "testbench compilation passed" || FAIL "testbench compilation failed"
  grep -r "assert property" tb/ >/dev/null 2>&1 && PASS "SVA assertions found" || WARN "No SVA assertions detected"
  grep -r '`LOG' tb/ >/dev/null 2>&1 && PASS "Structured LOG macros found" || WARN "No LOG macros detected"
  grep -q '\$fwrite' tb/tb_top.sv 2>/dev/null && PASS "File logging (\$fwrite) configured" || WARN "\$fwrite not found in testbench"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 4: 增量式 RTL 编码（分层验证）
# ---------------------------------------------------------------------------
check_phase_4() {
  total_errors=0; echo "=== Phase 4 检查点 ==="
  latest_log=$(ls -t logs/*.log 2>/dev/null | head -1)
  if [ -n "$latest_log" ]; then
    grep -q "SIMULATION COMPLETE" "$latest_log" && PASS "Simulation completed: $latest_log" || FAIL "Simulation did not complete: $latest_log"
    errors=$(grep -c "FAIL" "$latest_log" 2>/dev/null || echo "0")
    [ "$errors" -eq 0 ] && PASS "No failures in $latest_log" || FAIL "$errors failure(s) in $latest_log"
  else
    WARN "No simulation logs found in logs/"
  fi
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
# Phase 5: 回归 + 覆盖率
# ---------------------------------------------------------------------------
check_phase_5() {
  total_errors=0; echo "=== Phase 5 检查点 ==="
  make regress >/dev/null 2>&1 && PASS "Regression passed" || FAIL "Regression failed"
  coverage_report=$(ls -t logs/coverage*.txt 2>/dev/null | head -1)
  if [ -n "$coverage_report" ]; then
    mandatory=$(grep -oP 'mandatory:\s*\K[0-9.]+(?=%)' "$coverage_report" 2>/dev/null)
    if [ -n "$mandatory" ]; then
      [ "$(echo "$mandatory >= 100" | bc -l 2>/dev/null)" -eq 1 ] 2>/dev/null && \
        PASS "Mandatory coverage: ${mandatory}%" || FAIL "Mandatory coverage ${mandatory}% < 100%"
    else
      WARN "Could not parse mandatory coverage from $coverage_report"
    fi
  else
    WARN "No coverage report found"
  fi
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 6: 代码审查 + 升级检查
# ---------------------------------------------------------------------------
check_phase_6() {
  total_errors=0; echo "=== Phase 6 检查点 ==="
  # lint 门禁
  make lint >/dev/null 2>&1 && PASS "make lint zero warnings" || FAIL "lint warnings exist"
  grep -n 'assign.*=.*assign' rtl/*.sv 2>/dev/null && WARN "Potential combinational loop detected" || PASS "No obvious combinational loops"
  grep -r 'assert property' rtl/ tb/ >/dev/null 2>&1 && PASS "Assertions enabled" || WARN "No assertions found"
  [ -f "logs/coverage_report.txt" ] && PASS "Coverage report exists" || WARN "Coverage report missing"

  # === 升级检查：判断是否需要触发 architecture-review / security-review ===
  check_escalation

  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 7: 报告输出
# ---------------------------------------------------------------------------
check_phase_7() {
  total_errors=0; echo "=== Phase 7 检查点 ==="
  report=$(ls report_*_fpga_implementation.md 2>/dev/null | head -1)
  [ -n "$report" ] && PASS "Implementation report: $report" || WARN "No implementation report found"
  # 检查文档归档完整性
  [ -f algorithm_spec.md ] && PASS "algorithm_spec.md archived" || WARN "algorithm_spec.md not archived"
  [ -f fixed_point_report.md ] && PASS "fixed_point_report.md archived" || WARN "fixed_point_report.md not archived"
  [ -f resource_estimate.md ] && PASS "resource_estimate.md archived" || WARN "resource_estimate.md not archived"
  [ -d golden_model ] && PASS "golden_model/ archived" || WARN "golden_model/ not archived"
  # 经验记录
  grep -r "经验\|教训\|key decision\|lesson" memory/learnings/ 2>/dev/null 1>&2 && \
    PASS "Experience records found in memory/" || WARN "No experience records in memory/"
  return $total_errors
}

# ---------------------------------------------------------------------------
# 升级检查：判断是否需要触发架构/安全审查
# ---------------------------------------------------------------------------
check_escalation() {
  echo "--- 升级检查 ---"
  escalated=0

  # 1. 代码量 > 10K LOC → 建议架构审查
  total_loc=0
  for ext in sv v vhd; do
    count=$(find rtl/ -name "*.$ext" -o -name "*.${ext}0" 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
    total_loc=$((total_loc + count))
  done
  if [ "$total_loc" -gt 10000 ]; then
    WARN "代码量 ${total_loc} LOC > 10K，建议执行 architecture-review-workflow"
    escalated=1
  else
    PASS "代码量 ${total_loc} LOC，无需架构审查升级"
  fi

  # 2. 安全敏感关键词检测 → 建议安全审查
  security_pattern='(auth|token|password|secret|api[_-]key|credential|encrypt|decrypt|cipher|payment)'
  found_secure=$(grep -r -i "$security_pattern" rtl/ tb/ 2>/dev/null | wc -l)
  if [ "$found_secure" -gt 0 ]; then
    WARN "检测到 ${found_secure} 处安全敏感代码，建议执行 security-review-workflow"
    escalated=1
  else
    PASS "未检测到安全敏感关键词"
  fi

  # 3. 模块数检查（> 5 个主要模块 → 建议架构审查）
  module_count=$(find rtl/ -name "*_top.sv" -o -name "*_top.v" 2>/dev/null | wc -l)
  if [ "$module_count" -gt 5 ]; then
    WARN "检测到 ${module_count} 个顶层模块，建议架构一致性审查"
    escalated=1
  fi

  if [ "$escalated" -gt 0 ]; then
    echo -e "${YELLOW}==> 建议升级流程:${NC}"
    echo "    ▪ architecture-review-workflow"
    echo "    ▪ security-review-workflow"
  fi
}

# ---------------------------------------------------------------------------
# 全流程检查
# ---------------------------------------------------------------------------
check_all() {
  total_errors=0
  check_phase_0; check_phase_1; check_phase_2; check_phase_3
  check_phase_4; check_phase_5; check_phase_6; check_phase_7
  echo "=== 总计: $total_errors 个检查点未通过 ==="
  return $total_errors
}

# 直接执行时运行全流程检查
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  check_all
fi
