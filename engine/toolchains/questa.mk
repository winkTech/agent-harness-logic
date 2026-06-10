# toolchains/questa.mk — Mentor Questa / ModelSim 10.6c 工具链
# 由 harness-init 自动引用, 也可手动 include 到项目 Makefile
# 用法: include $(HOME)/.claude/engine/toolchains/questa.mk
#
# svcheck: 运行 ModelSim 10.6c SV 约束检查 (需 node)
#
# 覆盖以下变量以适配具体项目:
#   SRCS        — 源文件列表 (默认 auto-find)
#   VLOG_FLAGS  — vlog 编译选项
#   VSIM_FLAGS  — vsim 仿真选项
#   TOP_MODULE  — 顶层模块名 (默认 work.testbench)
#
# ModelSim 10.6c 限制:
#   - 不支持 let 声明、嵌套 module、clocking in modport
#   - 建议运行 modelsim-sv-constraints.cjs 检查

# ── 工具 ─────────────────────────────────────────────────────────────────────
VLOG     ?= vlog
VSIM     ?= vsim
VLOG_FLAGS ?= -sv -work work
VSIM_FLAGS ?= -c -do "run -all; quit"

# ── 源文件 ───────────────────────────────────────────────────────────────────
SRC_DIR  ?= 01_src
SRCS     ?= $(shell find $(SRC_DIR) -name '*.sv' -o -name '*.v' 2>/dev/null)

# ── 目标 ─────────────────────────────────────────────────────────────────────

.PHONY: lint compile sim wave coverage clean help

lint:
	@echo "=== Questa Lint ==="
	@for f in $(SRCS); do \
		echo "  $$f"; \
		$(VLOG) -lint $$f || exit 1; \
	done

compile:
	@echo "=== Questa Compile ==="
	$(VLOG) $(VLOG_FLAGS) $(SRCS)

sim: compile
	@echo "=== Questa Simulate ==="
	$(VSIM) $(VSIM_FLAGS) $(TOP_MODULE)

wave:
	@echo "=== Questa Wave ==="
	$(VSIM) -view dump.wlf

coverage:
	@echo "=== Questa Coverage ==="
	$(VSIM) -c -coverage -do "run -all; coverage save -onexit result.ucdb; quit" $(TOP_MODULE)

svcheck:
	@echo "=== ModelSim SV 约束检查 ==="
	@node $(HOME)/.claude/engine/scripts/modelsim-sv-constraints.cjs $(SRC_DIR)
