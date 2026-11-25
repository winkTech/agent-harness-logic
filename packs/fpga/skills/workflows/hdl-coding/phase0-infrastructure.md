# Phase 0: 基础设施统一层

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 统一 EDA 工具接口，建立可复用的构建系统。

## 0.1 工具抽象层 (TAL)

所有 Phase 通过以下抽象操作执行，具体命令由 Makefile 按所选工具链解析：

| 操作 | 抽象命令 | 功能 |
|------|---------|------|
| 代码检查 | `make lint` | 调用选定工具链的 lint 引擎 |
| 编译 | `make compile` | 增量编译所有源文件 |
| 仿真 | `make sim TEST=<case>` | 运行指定测试用例 |
| 波形仿真 | `make sim_wave TEST=<case>` | 带全信号波形 dump（FAIL 时自动保留波形文件） |
| 回归 | `make regress` | 全量回归测试 |
| 覆盖率 | `make coverage` | 收集并报告覆盖率 |

**支持的 EDA 工具链映射**：

| 抽象操作 | Questa/ModelSim | Synopsys VCS | Cadence Xcelium | Verilator |
|----------|----------------|-------------|-----------------|-----------|
| Lint | `vlog -lint` | `vlogan -lint` | `xrun -status` | `verilator --lint-only` |
| 编译 | `vlog -work work` | `vlogan -sverilog` + `vcs` | `xrun -compile` | `verilator --cc --sv` |
| 仿真 | `vsim -c -work work` | `./simv` | `xrun -R` | `./obj_dir/Vtop` |
| 波形 | `vsim -c -wlf` + `log -r /*` | `./simv -ucli` | `xrun -input` | `verilator --trace` |

## 0.2 构建系统规范

**Makefile 模板**（项目根目录 `Makefile`）：

```makefile
# 工具链选择 (questa / vcs / xcelium / verilator)
TOOLCHAIN ?= questa
.DEFAULT_GOAL := lint
include toolchains/$(TOOLCHAIN).mk

# 文件清单
RTL_SRC = $(shell cat filelist.f)
TB_SRC  = $(shell cat tb_filelist.f)

.PHONY: check-inputs lint compile sim sim_wave regress coverage

check-inputs:
	@test -d 01_src/00_hdl || { echo "missing RTL directory: 01_src/00_hdl"; exit 1; }
	@test -n "$(strip $(RTL_SRC))" || { echo "no design sources in filelist.f"; exit 1; }

lint: $(RTL_SRC) $(TB_SRC) | check-inputs
	@test -n "$(strip $(LINT_CMD))" || { echo "missing LINT_CMD"; exit 1; }
	$(LINT_CMD) $^

compile: $(RTL_SRC) $(TB_SRC) | check-inputs
	@test -n "$(strip $(COMPILE_CMD))" || { echo "missing COMPILE_CMD"; exit 1; }
	$(COMPILE_CMD) $^

sim: compile
	$(SIM_CMD) $(TEST)

sim_wave: compile
	$(SIM_WAVE_CMD) $(TEST)

regress: compile
	for t in $(TEST_LIST); do $(SIM_CMD) $$t; done
```

**工具链实现示例** — `toolchains/questa.mk`：

```makefile
LINT_CMD       = vlog -lint -work work
COMPILE_CMD    = vlog -sv -work work
SIM_CMD        = vsim -c -work work -do "source tests/$(TEST).tcl; run -all; exit" 2>&1 | tee logs/$(TEST).log
SIM_WAVE_CMD   = vsim -c -work work -wlf logs/$(TEST).wlf -do "log -r /*; source tests/$(TEST).tcl; run -all; exit"
TEST_LIST      = $(wildcard tests/*.tcl)
```

**文件清单管理** — 使用 `.f` 文件按依赖顺序排列源文件：

```bash
# filelist.f — RTL 源文件
../rtl/core_pkg.sv
../rtl/ahb_if.sv
../rtl/spi_master.sv

# tb_filelist.f — Testbench 源文件
../tb/tb_top.sv
../tb/scoreboard.sv
../tb/alignment_engine.sv
```

**增量编译原则**：仅修改过的文件及其下游依赖重编译。通过 Makefile 的自动依赖追踪生成 `.d` 文件实现。

## 检查点

- 选定工具链，Makefile + filelists 创建完成
- 从干净 Git 检出运行项目提供的目录恢复入口，对照受版本管理的契约核对目录。逐文件复核已冻结 Golden 的哈希，覆盖项目支持的 Git 换行配置。
- 缺 RTL 根目录、空设计源列表和故障探针均须可辨。用隔离的正常 HDL 探针实跑 lint/compile，再用含语法错误的探针验证退出码。新工程报告单列工具结果和实际 DUT 源文件数量。

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_0
```
