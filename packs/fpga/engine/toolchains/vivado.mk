# toolchains/vivado.mk — AMD Xilinx Vivado 工具链
# 由 harness-init 自动引用, 也可手动 include 到项目 Makefile
# 用法: include $(HOME)/.claude/engine/toolchains/vivado.mk
#
# 覆盖以下变量以适配具体项目:
#   SRCS        — 源文件列表 (默认 auto-find)
#   XVLOG_FLAGS — xvlog 编译选项
#   XELAB_FLAGS — xelab 编译选项
#   XSIM_FLAGS  — xsim 仿真选项
#   TOP_MODULE  — 顶层模块名
#   XDC_FILE    — 约束文件

# ── 工具 ─────────────────────────────────────────────────────────────────────
XVLOG    ?= xvlog
XELAB    ?= xelab
XSIM     ?= xsim
VIVADO   ?= vivado

XVLOG_FLAGS ?= -sv -work work
XELAB_FLAGS ?= -timescale 1ns/1ps
XSIM_FLAGS  ?= --runall

# ── 源文件 ───────────────────────────────────────────────────────────────────
SRC_DIR  ?= 01_src
SRCS     ?= $(shell find $(SRC_DIR) -name '*.sv' -o -name '*.v' 2>/dev/null)
XDC_FILE ?= fpga_constraints.xdc

# ── 目标 ─────────────────────────────────────────────────────────────────────

.PHONY: lint compile elab sim wave synth clean help

lint:
	@echo "=== Vivado Lint ==="
	@for f in $(SRCS); do \
		echo "  $$f"; \
		$(XVLOG) -sv -lint $$f || exit 1; \
	done

compile:
	@echo "=== Vivado Compile ==="
	$(XVLOG) $(XVLOG_FLAGS) $(SRCS)

elab: compile
	@echo "=== Vivado Elaborate ==="
	$(XELAB) $(XELAB_FLAGS) $(TOP_MODULE)

sim: elab
	@echo "=== Vivado Simulate ==="
	$(XSIM) $(TOP_MODULE) $(XSIM_FLAGS)

wave:
	@echo "=== Vivado Wave (GUI) ==="
	$(XSIM) --gui $(TOP_MODULE).wdb

synth:
	@echo "=== Vivado Synthesis ==="
	$(VIVADO) -mode batch -source synth.tcl

clean:
	rm -rf .Xil *.jou *.log *.wdb xsim.dir
