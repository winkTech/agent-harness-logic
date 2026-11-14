# toolchains/iverilog.mk — Icarus Verilog 工具链 (开源)
# 由 harness-init 自动引用, 也可手动 include 到项目 Makefile
# 用法: include $(HOME)/.claude/engine/toolchains/iverilog.mk
#
# 覆盖以下变量以适配具体项目:
#   SRCS        — 源文件列表 (默认 auto-find)
#   IVL_FLAGS   — iverilog 编译选项
#   VVP_FLAGS   — vvp 仿真选项
#   TOP_MODULE  — 顶层模块名
#
# Icarus 对 SystemVerilog 支持有限 (IEEE 1800-2009 子集)
# 建议使用 iverilog -g2012 获得最佳兼容性

# ── 工具 ─────────────────────────────────────────────────────────────────────
IVERILOG ?= iverilog
VVP      ?= vvp
GTKWAVE  ?= gtkwave

IVL_FLAGS ?= -g2012 -o sim.vvp
VVP_FLAGS ?= -lxt2

# ── 源文件 ───────────────────────────────────────────────────────────────────
SRC_DIR  ?= 01_src
TB_DIR   ?= 02_tb
SRCS     ?= $(shell find $(SRC_DIR) -name '*.sv' -o -name '*.v' 2>/dev/null)
TB_SRCS  ?= $(shell find $(TB_DIR) -name '*.sv' -o -name '*.v' 2>/dev/null)

# ── 目标 ─────────────────────────────────────────────────────────────────────

.PHONY: lint compile sim wave clean help

lint:
	@echo "=== Icarus Lint ==="
	@for f in $(SRCS); do \
		echo "  $$f"; \
		$(IVERILOG) $(IVL_FLAGS) -o /dev/null -s $(TOP_MODULE) $$f || exit 1; \
	done

compile: lint
	@echo "=== Icarus Compile ==="
	$(IVERILOG) $(IVL_FLAGS) $(SRCS) $(TB_SRCS)

sim: compile
	@echo "=== Icarus Simulate ==="
	$(VVP) sim.vvp $(VVP_FLAGS)

wave:
	@echo "=== GTKWave ==="
	$(GTKWAVE) dump.vcd

clean:
	rm -f sim.vvp *.vcd *.lxt *.lst
