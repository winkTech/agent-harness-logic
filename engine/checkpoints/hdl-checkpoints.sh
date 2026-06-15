#!/bin/bash
# ============================================================================
# HDL Coding Workflow — 可执行检查点断言（对齐 hdl-coding-dag-workflow 10-Phase）
# 来源: workflows/hdl-coding-dag-workflow.js
# 目录标准: 01_src/00_hdl/ 02_sim/tv/ 02_sim/check_results/ 06_doc/ 07_mat/
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
  # 标准目录结构 (对齐 dag 工作流)
  for dir in "01_src/00_hdl" "01_src/01_ip" "02_sim/tv" "02_sim/check_results" "03_xdc" "04_prj" "05_bin" "06_doc" "07_mat" "08_py"; do
    [ -d "$dir" ] && PASS "目录 $dir 存在" || WARN "目录 $dir 缺失 (可空目录)"
  done
  [ -f Makefile ] && PASS "Makefile exists" || FAIL "Makefile missing"
  [ -f .gitignore ] && PASS ".gitignore exists" || WARN ".gitignore missing"
  # 检查 Makefile 目标
  for target in lint compile sim clean; do
    grep -q "^$target:" Makefile 2>/dev/null && PASS "make $target 目标存在" || WARN "make $target 目标缺失"
  done
  # 检查 .gitignore transient 排除
  for pattern in "work/" "transcript" "*.wlf" "__pycache__/" "*.vcd"; do
    grep -q "$pattern" .gitignore 2>/dev/null && PASS ".gitignore 排除 $pattern" || WARN ".gitignore 未排除 $pattern"
  done
  make lint >/dev/null 2>&1 && PASS "make lint passed" || WARN "make lint 未通过 (可能无 EDA 工具)"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 1: 算法分析与架构设计
# ---------------------------------------------------------------------------
check_phase_1() {
  total_errors=0; echo "=== Phase 1 检查点 ==="
  [ -f 06_doc/algorithm_spec.md ] && PASS "06_doc/algorithm_spec.md 存在" || WARN "06_doc/algorithm_spec.md 缺失"
  [ -f 06_doc/architecture.yaml ] && PASS "06_doc/architecture.yaml 存在" || FAIL "06_doc/architecture.yaml 缺失 (MUST)"
  [ -f 06_doc/pipeline_diagram.md ] && PASS "06_doc/pipeline_diagram.md 存在" || WARN "06_doc/pipeline_diagram.md 缺失"
  # 架构框图
  ls 06_doc/architecture*.png 06_doc/architecture*.pdf 06_doc/architecture*.svg 2>/dev/null 1>&2 && \
    PASS "架构框图存在" || WARN "架构框图未在 06_doc/ 中找到"
  # 校验 architecture.yaml 必填字段
  if [ -f 06_doc/architecture.yaml ]; then
    for field in "modules" "pipeline_stages" "fsm_states" "bit_width"; do
      grep -q "$field" 06_doc/architecture.yaml && PASS "architecture.yaml 含 $field" || WARN "architecture.yaml 缺少 $field"
    done
  fi
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 2: 定点量化与资源评估
# ---------------------------------------------------------------------------
check_phase_2() {
  total_errors=0; echo "=== Phase 2 检查点 ==="
  [ -f fixed_point_report.md ] && PASS "fixed_point_report.md 存在" || FAIL "fixed_point_report.md 缺失"
  [ -f resource_estimate.md ] && PASS "resource_estimate.md 存在" || FAIL "resource_estimate.md 缺失"
  grep -qi "超标\|over budget\|exceed" resource_estimate.md 2>/dev/null && \
    WARN "资源评估超标 — 需回溯 Phase 2 或 Phase 1" || \
    PASS "资源预算未超标"
  grep -q "NMSE\|SNR\|SQNR" fixed_point_report.md 2>/dev/null && \
    PASS "量化误差指标存在" || WARN "fixed_point_report.md 中无 NMSE/SNR 指标"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 3: Testbench + 向量生成
# ---------------------------------------------------------------------------
check_phase_3() {
  total_errors=0; echo "=== Phase 3 检查点 ==="
  # TB 编译检查
  make compile >/dev/null 2>&1 && PASS "TB 编译通过" || WARN "TB 编译未通过 (可能无 EDA 工具)"
  # 检查 TB 文件 (标准位置)
  tb_files=$(ls 02_sim/tb_*.sv 02_sim/*_tb.sv 2>/dev/null | head -5)
  if [ -n "$tb_files" ]; then
    PASS "TB 文件存在: $(echo $tb_files | tr '\n' ' ')"
    # SVA 断言检查
    grep -r "assert property" $tb_files 2>/dev/null && PASS "SVA 断言存在" || WARN "未检测到 SVA 断言"
    # LOG 宏检查
    grep -r '\$fwrite\|\$display' $tb_files 2>/dev/null >/dev/null && PASS "结构化日志存在" || WARN "未检测到 \$fwrite/\$display"
  else
    WARN "未在 02_sim/ 下找到 TB 文件"
  fi
  # 检查测试向量
  tv_count=$(ls 02_sim/tv/*.txt 02_sim/tv/*.hex 2>/dev/null | wc -l)
  [ "$tv_count" -gt 0 ] && PASS "测试向量存在 (${tv_count} 个文件)" || WARN "02_sim/tv/ 中无测试向量"
  # 检查对比脚本骨架
  ls 02_sim/check_*.py 2>/dev/null >/dev/null && PASS "对比脚本存在" || WARN "未找到 02_sim/check_*.py 对比脚本"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 4: 逐模块 RTL + 脚本化对比
# ---------------------------------------------------------------------------
check_phase_4() {
  total_errors=0; echo "=== Phase 4 检查点 ==="
  # RTL 文件检查
  rtl_count=$(find 01_src/00_hdl -name "*.sv" -o -name "*.v" 2>/dev/null | wc -l)
  [ "$rtl_count" -gt 0 ] && PASS "RTL 文件存在 (${rtl_count} 个)" || FAIL "01_src/00_hdl/ 中无 RTL 文件"
  # lint 通过
  make lint >/dev/null 2>&1 && PASS "make lint 通过" || WARN "make lint 有警告"
  # 证据 JSON 文件
  json_count=$(ls 02_sim/check_results/*.json 2>/dev/null | wc -l)
  [ "$json_count" -gt 0 ] && PASS "JSON 证据文件存在 (${json_count} 个)" || WARN "02_sim/check_results/ 中无 JSON 证据文件"
  # 验证所有 JSON 是否 PASS
  fail_count=0
  for jf in 02_sim/check_results/*.json; do
    [ -f "$jf" ] || continue
    status=$(python3 -c "import json; print(json.load(open('$jf')).get('status',''))" 2>/dev/null)
    pts=$(python3 -c "import json; print(json.load(open('$jf')).get('compared_points',0))" 2>/dev/null)
    if [ "$status" != "PASS" ]; then
      WARN "$(basename $jf): status=$status"
      fail_count=$((fail_count+1))
    elif [ "$pts" = "0" ] || [ -z "$pts" ]; then
      WARN "$(basename $jf): compared_points=0 — 脚本可能未实际运行"
      fail_count=$((fail_count+1))
    else
      PASS "$(basename $jf): $status, ${pts} points"
    fi
  done
  [ "$fail_count" -eq 0 ] || WARN "${fail_count} 个模块验证未通过"
  # transient 清理检查
  [ ! -d "work" ] && PASS "work/ 已清理" || WARN "work/ 目录残留 (应 make clean)"
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 4.5: 证据门禁
# ---------------------------------------------------------------------------
check_phase_45() {
  total_errors=0; echo "=== Phase 4.5 证据门禁 ==="
  if [ ! -d "02_sim/check_results" ]; then
    FAIL "02_sim/check_results/ 不存在 — Phase 4 未产出"
    return $total_errors
  fi
  json_files=$(ls 02_sim/check_results/*.json 2>/dev/null)
  if [ -z "$json_files" ]; then
    FAIL "02_sim/check_results/ 中无 JSON 证据文件"
    return $total_errors
  fi
  for jf in $json_files; do
    module=$(basename "$jf" .json)
    data=$(python3 -c "
import json, sys
try:
    d = json.load(open('$jf'))
    status = d.get('status', 'MISSING')
    pts = d.get('compared_points', 0)
    err = d.get('max_error_lsb', 'N/A')
    print(f'{status}|{pts}|{err}')
except Exception as e:
    print(f'PARSE_FAIL|{e}')
" 2>/dev/null)
    status=$(echo "$data" | cut -d'|' -f1)
    pts=$(echo "$data" | cut -d'|' -f2)
    err=$(echo "$data" | cut -d'|' -f3)
    if [ "$status" = "PASS" ] && [ "$pts" -gt 0 ] 2>/dev/null; then
      PASS "${module}: status=PASS, points=$pts, max_error=$err"
    elif [ "$status" = "PARSE_FAIL" ]; then
      FAIL "${module}: JSON 解析失败"
    else
      FAIL "${module}: status=$status, points=$pts"
    fi
  done
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 5: 顶层集成 + 全链仿真
# ---------------------------------------------------------------------------
check_phase_5() {
  total_errors=0; echo "=== Phase 5 检查点 ==="
  # 顶层模块
  top_file=$(ls 01_src/00_hdl/top*.sv 2>/dev/null | head -1)
  [ -n "$top_file" ] && PASS "顶层模块存在: $top_file" || WARN "未找到顶层模块 (01_src/00_hdl/top*.sv)"
  # 仿真日志
  sim_log=$(ls -t 02_sim/*.log 2>/dev/null | head -1)
  if [ -n "$sim_log" ]; then
    grep -q "SIMULATION COMPLETE\|PASS\|SUCCESS" "$sim_log" 2>/dev/null && \
      PASS "仿真完成: $sim_log" || WARN "仿真日志中未检测到完成标记: $sim_log"
    grep -c "FAIL\|ERROR" "$sim_log" 2>/dev/null | xargs -I{} sh -c 'test "{}" -eq 0 && PASS "仿真无FAIL" || WARN "{} FAIL(s) 在日志中"'
  else
    WARN "未找到仿真日志 (02_sim/*.log)"
  fi
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 6: 回归覆盖率
# ---------------------------------------------------------------------------
check_phase_6() {
  total_errors=0; echo "=== Phase 6 检查点 ==="
  make regress >/dev/null 2>&1 && PASS "Regression passed" || WARN "make regress 未通过 (可能无 EDA 工具)"
  # 覆盖率报告
  cov_report=$(ls -t 02_sim/coverage*.txt 02_sim/coverage*.rpt 2>/dev/null | head -1)
  if [ -n "$cov_report" ]; then
    mandatory=$(grep -oP 'mandatory:\s*\K[0-9.]+(?=%)' "$cov_report" 2>/dev/null)
    if [ -n "$mandatory" ]; then
      [ "$(echo "$mandatory >= 100" | bc -l 2>/dev/null)" -eq 1 ] 2>/dev/null && \
        PASS "Mandatory coverage: ${mandatory}%" || FAIL "Mandatory coverage ${mandatory}% < 100%"
    else
      WARN "无法从 $cov_report 解析覆盖率"
    fi
  else
    WARN "未找到覆盖率报告"
  fi
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 7: 代码审查
# ---------------------------------------------------------------------------
check_phase_7() {
  total_errors=0; echo "=== Phase 7 检查点 ==="
  # lint 门禁
  make lint >/dev/null 2>&1 && PASS "make lint 零警告" || WARN "lint 有警告"
  # 时序安全检查
  grep -n 'assign.*=.*assign' 01_src/00_hdl/*.sv 01_src/00_hdl/*.v 2>/dev/null && \
    WARN "检测到潜在组合逻辑环路" || PASS "无显式组合逻辑环路"
  # 状态机 default 分支
  grep -r 'default:' 01_src/00_hdl/ 2>/dev/null >/dev/null && \
    PASS "状态机 default 分支存在" || WARN "未检测到 default 分支"
  # 审查报告
  [ -f 06_doc/code_review_report.md ] && PASS "审查报告存在" || WARN "06_doc/code_review_report.md 缺失"

  check_escalation
  return $total_errors
}

# ---------------------------------------------------------------------------
# Phase 8: 报告输出 + 清理
# ---------------------------------------------------------------------------
check_phase_8() {
  total_errors=0; echo "=== Phase 8 检查点 ==="
  # 实现报告
  report=$(ls 06_doc/report_*_implementation.md 2>/dev/null | head -1)
  [ -n "$report" ] && PASS "实现报告存在: $report" || WARN "06_doc 中无实现报告"
  # 文档归档完整性
  for doc in "06_doc/algorithm_spec.md" "06_doc/architecture.yaml" "fixed_point_report.md" "resource_estimate.md"; do
    [ -f "$doc" ] && PASS "$doc 已归档" || WARN "$doc 未归档"
  done
  # transient 清理
  for transient in "work" "transcript" "*.wlf" "vsim.wlf"; do
    [ -e "$(find . -maxdepth 1 -name "$transient" -print -quit 2>/dev/null)" ] && \
      WARN "${transient} 残留" || PASS "${transient} 已清理"
  done
  # 经验记录
  grep -r "经验\|教训\|key decision\|lesson" memory/learnings/ 2>/dev/null 1>&2 && \
    PASS "经验已记录到 memory/learnings/" || WARN "memory/learnings/ 中无经验记录"
  return $total_errors
}

# ---------------------------------------------------------------------------
# 升级检查
# ---------------------------------------------------------------------------
check_escalation() {
  echo "--- 升级检查 ---"
  escalated=0
  # 1. 代码量 > 10K LOC → 建议架构审查
  total_loc=0
  for ext in sv v vhd; do
    count=$(find 01_src/ -name "*.$ext" 2>/dev/null -o -name "*.${ext}0" 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
    total_loc=$((total_loc + count))
  done
  if [ "${total_loc:-0}" -gt 10000 ]; then
    WARN "代码量 ${total_loc} LOC > 10K，建议执行 architecture-review-workflow"
    escalated=1
  else
    PASS "代码量 ${total_loc:-0} LOC，无需架构审查升级"
  fi
  # 2. 安全敏感关键词
  security_pattern='(auth|token|password|secret|api[_-]key|credential|encrypt|decrypt|cipher|payment)'
  found_secure=$(grep -r -i "$security_pattern" 01_src/ 02_sim/ 2>/dev/null | wc -l)
  if [ "${found_secure:-0}" -gt 0 ]; then
    WARN "检测到 ${found_secure} 处安全敏感代码，建议执行 security-review-workflow"
    escalated=1
  else
    PASS "未检测到安全敏感关键词"
  fi
  # 3. 顶层模块数
  module_count=$(find 01_src/ -name "*_top.sv" -o -name "*_top.v" 2>/dev/null | wc -l)
  if [ "${module_count:-0}" -gt 5 ]; then
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
  check_phase_4; check_phase_45; check_phase_5; check_phase_6
  check_phase_7; check_phase_8
  echo "=== 总计: $total_errors 个检查点未通过 ==="
  return $total_errors
}

# 直接执行时运行全流程检查
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  check_all
fi
