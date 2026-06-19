#!/bin/bash
#
# init-project.sh — FPGA 标准项目初始化脚本
#
# 用法: init-project.sh <project_name> [device]
#
# 创建标准 FPGA 项目目录结构 (prj/), 生成 Makefile / .gitignore / README.md,
# 初始化 git 仓库并创建初始提交。
#
# 参数:
#   project_name  项目名 (必需, 字母/数字/下划线/连字符)
#   device        Target 器件 (默认: xc7k325tffg900-2)
#
# 示例:
#   init-project.sh my_project xc7k325tffg900-2
#

set -euo pipefail

# ─── 颜色定义 ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ─── 帮助 ─────────────────────────────────────────────────────────────────
usage() {
    echo "用法: $0 <project_name> [device]"
    echo ""
    echo "参数:"
    echo "  project_name   项目名 (必需)"
    echo "  device         Target 器件 (默认: xc7k325tffg900-2)"
    echo ""
    echo "示例:"
    echo "  $0 my_project xc7k325tffg900-2"
    echo "  $0 ofdm_rx"
    exit 1
}

# ─── 参数解析 ─────────────────────────────────────────────────────────────
if [ $# -lt 1 ]; then
    usage
fi

PROJECT_NAME="$1"
DEVICE="${2:-xc7k325tffg900-2}"

# 校验项目名
if [[ ! "$PROJECT_NAME" =~ ^[a-zA-Z][a-zA-Z0-9_-]*$ ]]; then
    echo -e "${RED}错误: 无效的项目名 \"$PROJECT_NAME\"。${NC}"
    echo "项目名只能包含字母、数字、下划线和连字符，且必须以字母开头。"
    exit 1
fi

PROJECT_DIR="./prj"

# 检查目标目录是否已存在
if [ -d "$PROJECT_DIR" ]; then
    echo -e "${YELLOW}警告: $PROJECT_DIR 已存在。${NC}"
    echo "请先删除已有目录或更换位置。"
    exit 1
fi

# ─── 步骤 1: 创建目录结构 ────────────────────────────────────────────────
echo -e "${GREEN}[1/6] 创建目录结构...${NC}"

mkdir -p "$PROJECT_DIR"/00_comm
mkdir -p "$PROJECT_DIR"/01_src/00_hdl/00_com
mkdir -p "$PROJECT_DIR"/01_src/01_ip
mkdir -p "$PROJECT_DIR"/02_sim/tv
mkdir -p "$PROJECT_DIR"/02_sim/check_results
mkdir -p "$PROJECT_DIR"/03_xdc
mkdir -p "$PROJECT_DIR"/04_prj
mkdir -p "$PROJECT_DIR"/05_bin
mkdir -p "$PROJECT_DIR"/06_doc
mkdir -p "$PROJECT_DIR"/07_mat/00_fx
mkdir -p "$PROJECT_DIR"/07_mat/01_conf
mkdir -p "$PROJECT_DIR"/07_mat/02_tests
mkdir -p "$PROJECT_DIR"/08_py

# 在空目录中放置 .gitkeep 以保留目录结构
for dir in \
    "$PROJECT_DIR"/00_comm \
    "$PROJECT_DIR"/01_src/00_hdl/00_com \
    "$PROJECT_DIR"/01_src/01_ip \
    "$PROJECT_DIR"/02_sim/tv \
    "$PROJECT_DIR"/02_sim/check_results \
    "$PROJECT_DIR"/03_xdc \
    "$PROJECT_DIR"/04_prj \
    "$PROJECT_DIR"/05_bin \
    "$PROJECT_DIR"/06_doc \
    "$PROJECT_DIR"/07_mat/00_fx \
    "$PROJECT_DIR"/07_mat/01_conf \
    "$PROJECT_DIR"/07_mat/02_tests \
    "$PROJECT_DIR"/08_py; do
    touch "$dir/.gitkeep"
done

echo -e "  ${CYAN}✓${NC} 目录结构已创建"

# ─── 步骤 2: 写入 Makefile ────────────────────────────────────────────────
echo -e "${GREEN}[2/6] 写入 Makefile...${NC}"

cat > "$PROJECT_DIR"/Makefile << 'MAKEFILE'
# ============================================================================
# Makefile — FPGA Project
# ============================================================================
# Targets:
#   lint      — 语法检查 (vlog -lint)
#   compile   — 编译所有源文件
#   sim       — 仿真 (+DUMPSIGNALS=1, 输出波形)
#   clean     — 清除构建产物
#   coverage  — 覆盖率收集 (vcover report)
#   regress   — 并行运行所有 testbench
# ============================================================================

# ─── Toolchain (可从环境变量覆盖) ─────────────────────────────────────────
#   make VLOG=xvlog VSIM=xsim ...
VLOG     ?= vlog
VSIM     ?= vsim
VCOVER   ?= vcover
VWORK    ?= work

# ─── Device ────────────────────────────────────────────────────────────────
DEVICE   := __DEVICE__

# ─── 目录 ──────────────────────────────────────────────────────────────────
HDL_DIR  := 01_src/00_hdl
SIM_DIR  := 02_sim
XDC_DIR  := 03_xdc

# ─── 源文件 (自动发现) ─────────────────────────────────────────────────────
SRC_FILES  := $(shell find $(HDL_DIR) -type f \( -name '*.sv' -o -name '*.v' \) 2>/dev/null | sort)
TB_FILES   := $(shell find $(SIM_DIR) -type f \( -name 'tb_*.sv' -o -name 'tb_*.v' \) 2>/dev/null | sort)
TB_TOP     ?= $(firstword $(notdir $(basename $(TB_FILES))))

.PHONY: all lint compile sim clean coverage regress help

all: lint compile

# ─── lint — 语法检查 ───────────────────────────────────────────────────────
lint:
	@echo "=== Lint: $(HDL_DIR) ==="
	$(VLOG) -lint $(SRC_FILES)

# ─── compile — 编译所有源文件 ──────────────────────────────────────────────
compile:
	@echo "=== Compile ==="
	$(VLOG) -work $(VWORK) $(SRC_FILES) $(TB_FILES)

# ─── sim — 运行仿真 (波形输出) ─────────────────────────────────────────────
sim:
	@echo "=== Simulate: $(TB_TOP) ==="
	$(VSIM) -c -novopt -do "run -all; quit" +DUMPSIGNALS=1 $(TB_TOP)

# ─── clean — 清理产物 ──────────────────────────────────────────────────────
clean:
	@echo "=== Clean ==="
	rm -rf $(VWORK)/
	rm -f transcript *.wlf vsim.wlf
	rm -rf __pycache__/
	rm -f *.pyc *.vcd *.vcd.lxt *.ini *.log *.jou *.str
	@echo "  Done."

# ─── coverage — 覆盖率报告 ──────────────────────────────────────────────────
coverage: compile
	@echo "=== Coverage ==="
	$(VSIM) -c -coverage -do "coverage save -onexit; run -all; coverage report -file coverage.rpt; quit" $(TB_TOP)
	$(VCOVER) report -htm coverage.html -file coverage.rpt
	@echo "  Report: coverage.html"

# ─── regress — 并行回归测试 ────────────────────────────────────────────────
regress:
	@echo "=== Regression: $(words $(TB_FILES)) testbenches ==="
	@set -e; \
	for tb_path in $(TB_FILES); do \
		tb_mod=$$(basename "$$tb_path"); \
		tb_mod=$${tb_mod%.sv}; \
		tb_mod=$${tb_mod%.v}; \
		echo "  [Start] $$tb_mod"; \
		$(VSIM) -c -do "run -all; quit" +DUMPSIGNALS=1 "$$tb_mod" > "$$tb_mod.log" 2>&1 & \
	done; \
	wait; \
	echo "=== Results ==="; \
	fail=0; pass=0; \
	for tb_path in $(TB_FILES); do \
		tb_mod=$$(basename "$$tb_path"); \
		tb_mod=$${tb_mod%.sv}; \
		tb_mod=$${tb_mod%.v}; \
		if grep -q "Errors: 0" "$$tb_mod.log" 2>/dev/null; then \
			echo "  [PASS] $$tb_mod"; \
			pass=$$((pass + 1)); \
		else \
			echo "  [FAIL] $$tb_mod (see $$tb_mod.log)"; \
			fail=$$((fail + 1)); \
		fi; \
	done; \
	echo "  $$pass passed, $$fail failed"; \
	if [ "$$fail" -gt 0 ]; then exit 1; fi

# ─── help — 帮助信息 ───────────────────────────────────────────────────────
help:
	@echo "Available targets:"
	@echo "  all       — Lint + compile"
	@echo "  lint      — Lint all HDL sources in $(HDL_DIR)"
	@echo "  compile   — Compile all sources"
	@echo "  sim       — Run simulation (default: first TB found)"
	@echo "             Override: make sim TB_TOP=tb_foo"
	@echo "  clean     — Remove build artifacts"
	@echo "  coverage  — Collect coverage report"
	@echo "  regress   — Run all testbenches in parallel"
MAKEFILE

# 替换设备占位符
if [[ "$(uname -s)" == "Darwin" ]]; then
    sed -i '' "s/__DEVICE__/$DEVICE/" "$PROJECT_DIR"/Makefile
else
    sed -i "s/__DEVICE__/$DEVICE/" "$PROJECT_DIR"/Makefile
fi

echo -e "  ${CYAN}✓${NC} Makefile 已写入 (device: $DEVICE)"

# ─── 步骤 3: 写入 .gitignore ──────────────────────────────────────────────
echo -e "${GREEN}[3/6] 写入 .gitignore...${NC}"

cat > "$PROJECT_DIR"/.gitignore << 'GITIGNORE'
# ── FPGA 仿真产物 ──────────────────────────────────────────────────────────
work/
transcript
*.wlf
vsim.wlf
*.vcd
*.vcd.lxt
*.ini

# ── Vivado ─────────────────────────────────────────────────────────────────
*.jou
*.log
*.str
*.xpe
*.xrpt
*.xml
*.hw_platform/
.ip_user_files/
.xil/

# ── Python ─────────────────────────────────────────────────────────────────
__pycache__/
*.pyc
*.pyo
.env
.venv/
venv/

# ── OS ─────────────────────────────────────────────────────────────────────
.DS_Store
Thumbs.db
*.swp
*.swo

# ── 编译输出 ────────────────────────────────────────────────────────────────
05_bin/
*.bit
*.bin
*.mcs
GITIGNORE

echo -e "  ${CYAN}✓${NC} .gitignore 已写入"

# ─── 步骤 4: 写入 README.md ───────────────────────────────────────────────
echo -e "${GREEN}[4/6] 写入 README.md...${NC}"

cat > "$PROJECT_DIR"/README.md << README
# $PROJECT_NAME

## Overview

FPGA project.

## Device

- **Part**: $DEVICE

## Directory Structure

| Directory | Description |
|:----------|:------------|
| \`00_comm/\` | Global scripts, configuration files |
| \`01_src/00_hdl/\` | HDL source code (per module) |
| \`01_src/01_ip/\` | IP cores (clk/mem/dsp/comm) |
| \`02_sim/\` | Simulation (testbenches, vectors, results) |
| \`03_xdc/\` | Constraint files |
| \`04_prj/\` | Project files |
| \`05_bin/\` | Bitstreams and binaries |
| \`06_doc/\` | Design documentation |
| \`07_mat/\` | MATLAB golden model (functions/config/tests) |
| \`08_py/\` | Python scripts |

## Quick Start

\`\`\`bash
# Lint all sources
make lint

# Compile all sources
make compile

# Run simulation (requires a testbench)
make sim

# Run all testbenches
make regress

# Clean build artifacts
make clean
\`\`\`

## Adding a Module

\`\`\`bash
/path/to/init-module.sh <module_name> [data_width]
\`\`\`

## Prerequisites

- ModelSim / Vivado (for simulation)
- GNU Make

## License

Internal use only.
README

echo -e "  ${CYAN}✓${NC} README.md 已写入"

# ─── 步骤 5: Git init ─────────────────────────────────────────────────────
echo -e "${GREEN}[5/6] 初始化 git 仓库...${NC}"

cd "$PROJECT_DIR"
git init
git add -A
git commit -m "init: $PROJECT_NAME"
cd ..

echo -e "  ${CYAN}✓${NC} Git 仓库已初始化并提交"

# ─── 步骤 6: 完成 ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}========================================================${NC}"
echo -e "${GREEN}  项目 \"$PROJECT_NAME\" 创建成功!${NC}"
echo -e "${GREEN}  路径: $(pwd)/$PROJECT_DIR${NC}"
echo -e "${GREEN}  器件: $DEVICE${NC}"
echo -e "${GREEN}========================================================${NC}"
echo ""
echo -e "${YELLOW}下一步:${NC}"
echo "  1. cd $PROJECT_DIR"
echo "  2. 编辑 README.md 补充项目详细说明"
echo "  3. 添加新模块:"
echo "     bash /path/to/init-module.sh <module_name>"
echo "  4. 开始编码!"
echo ""
