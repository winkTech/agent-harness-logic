# toolchains/modelsim.mk — Intel ModelSim (独立版, 非 Mentor Questa)
# 由 harness-init 自动引用, 也可手动 include 到项目 Makefile
# 用法: include $(HOME)/.claude/engine/toolchains/modelsim.mk
#
# ModelSim 与 Questa 共享同一 vlog/vsim 命令接口, 但功能集不同:
#   - ModelSim 10.6c: SV 支持有限, 不支持 let/嵌套 module/clocking in modport
#   - Questa: 完整 SV 支持, 有 coverage 功能
#
# 建议运行 SV 约束检查:
#   make svcheck
#
# 覆盖以下变量以适配具体项目:
#   SRCS        — 源文件列表 (默认 auto-find)
#   VLOG_FLAGS  — vlog 编译选项
#   VSIM_FLAGS  — vsim 仿真选项
#   TOP_MODULE  — 顶层模块名

# ── 工具 ─────────────────────────────────────────────────────────────────────
VLOG     ?= vlog
VSIM     ?= vsim
VLOG_FLAGS ?= -sv -work work
VSIM_FLAGS ?= -c -do "run -all; quit"

# ── 源文件 ───────────────────────────────────────────────────────────────────
SRC_DIR  ?= 01_src
SRCS     ?= $(shell find $(SRC_DIR) -name '*.sv' -o -name '*.v' 2>/dev/null)

# ── 目标 ─────────────────────────────────────────────────────────────────────

.PHONY: lint compile sim wave check clean help

lint:
	@echo "=== ModelSim Lint ==="
	@for f in $(SRCS); do \
		echo "  $$f"; \
		$(VLOG) -lint $$f || exit 1; \
	done

compile:
	@echo "=== ModelSim Compile ==="
	$(VLOG) $(VLOG_FLAGS) $(SRCS)

sim: compile
	@echo "=== ModelSim Simulate ==="
	$(VSIM) $(VSIM_FLAGS) $(TOP_MODULE)

wave:
	@echo "=== ModelSim Wave ==="
	$(VSIM) -view dump.wlf

svcheck:
	@echo "=== ModelSim 10.6c SV 约束检查 ==="
	@node $(HOME)/.claude/engine/scripts/modelsim-sv-constraints.cjs $(SRC_DIR)

clean:
	rm -rf work *.log *.vcd *.wlf
