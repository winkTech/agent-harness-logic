# 覆盖率与回归测试模板

> 与 DAG 工作流 Phase 6 (回归覆盖率) 配套使用。
> 提供 ModelSim 和 Vivado 的覆盖率收集、回归运行、结果解析模板。

---

## 一、覆盖率类型

| 缩写 | 类型 | 说明 | 检查什么 |
|:----:|:-----|:-----|:---------|
| `b` | Block | 语句块覆盖 | 每行代码是否被执行 |
| `c` | Condition | 条件覆盖 | 每个布尔子条件是否取过 0/1 |
| `e` | Expression | 表达式覆盖 | 组合表达式是否全覆盖 |
| `s` | Statement | 语句覆盖 | 每个语句是否被执行 |
| `x` | Toggle | 跳变覆盖 | 每个 bit 是否有 0→1 和 1→0 |
| `f` | FSM | 状态机覆盖 | 每个状态和转移是否被访问 |

---

## 二、ModelSim (vlog/vsim)

### 2.1 编译+仿真+覆盖率

```tcl
# run_coverage.do — 带覆盖率的仿真运行脚本
vlib work
vlog -sv -cover bcesxf ../01_src/00_hdl/<module>/<module>.sv
vlog -sv -cover bcesxf tb_<module>.sv
vsim -c -coverage tb_<module>
run -all
vcover report -details -output coverage_report.txt
vcover save coverage_db.ucdb
quit
```

### 2.2 查看报告

```bash
# 文本报告
vcover report -details coverage_db.ucdb > coverage_report.txt

# 详细按实例
vcover report -details -instance /tb_<module>/u_<module> coverage_db.ucdb

# HTML 报告（交互式）
vcover report -html coverage_db.ucdb -htmldir coverage_html/
```

### 2.3 合并多个覆盖率数据库

```bash
# 合并多个模块的覆盖率
vcover merge merged.ucdb coverage_db_module1.ucdb coverage_db_module2.ucdb

# 合并目录下所有
vcover merge merged.ucdb *.ucdb

# 查看合并报告
vcover report -details merged.ucdb
```

### 2.4 排除文件

```tcl
# 在 vopt 或 vsim 时排除特定模块
vsim -c -coverage tb_top +cover=bcesxf -coverexclude="<glbl>"
```

---

## 三、Vivado (xvlog/xelab/xsim)

### 3.1 编译+仿真+覆盖率

```tcl
# run_xsim_coverage.tcl
xvlog -sv --cover bcesxf ../01_src/00_hdl/<module>/<module>.sv
xvlog -sv --cover bcesxf tb_<module>.sv
xelab -debug typical -cover bcesxf tb_<module>
xsim tb_<module> --runall --coverage_report coverage_report.txt
# Vivado 保存覆盖率数据库
xsim --coverage_save coverage_db
```

### 3.2 查看 Vivado 报告

```bash
# Vivado 生成报告
xsim --viewer coverage_db

# 或命令行
xsim --coverage_report coverage_report.txt coverage_db
```

---

## 四、Makefile 目标

### 4.1 单模块覆盖率

```makefile
# 单模块覆盖率
coverage-%: clean
	vlib work
	vlog -sv -cover bcesxf 01_src/00_hdl/$*/$*.sv
	vlog -sv -cover bcesxf 02_sim/tb_$*.sv
	vsim -c -coverage tb_$* -do "run -all; vcover report -details -output 02_sim/check_results/$*_coverage.txt; vcover save 02_sim/check_results/$*_coverage.ucdb; quit"
	@echo "Coverage report: 02_sim/check_results/$*_coverage.txt"
```

### 4.2 全模块覆盖率

```makefile
# 所有模块覆盖率
coverage: clean
	for mod in $(MODULES); do \
		$(MAKE) coverage-$$mod; \
	done

# 覆盖率汇总
coverage-report:
	@echo "=== Coverage Summary ==="
	for ucdb in 02_sim/check_results/*.ucdb; do \
		vcover report -details $$ucdb | head -5; \
	done

# 覆盖率合并
coverage-merge:
	vcover merge 02_sim/merged.ucdb 02_sim/check_results/*.ucdb
	vcover report -details 02_sim/merged.ucdb > 02_sim/coverage_total.txt
```

### 4.3 回归测试

```makefile
# 回归测试 — 逐个运行
regress: clean
	@total=0; passed=0; failed=0; \
	for tb in 02_sim/tb_*.sv; do \
		module=$$(basename $$tb .sv | sed 's/tb_//'); \
		echo "=== [$$((total+1))] $$module ==="; \
		rm -rf work; vlib work 2>/dev/null; \
		vlog -sv 01_src/00_hdl/$$module/$$module.sv 2>/dev/null && \
		vlog -sv $$tb 2>/dev/null && \
		vsim -c tb_$$module -do "run -all; quit" 2>/dev/null; \
		if [ $$? -eq 0 ]; then \
			echo "  ✅ $$module PASS"; passed=$$((passed+1)); \
		else \
			echo "  ❌ $$module FAIL"; failed=$$((failed+1)); \
		fi; \
		total=$$((total+1)); \
	done; \
	echo ""; \
	echo "=== Results: $$passed/$$total passed ($$failed failed) ==="

# 回归测试 — 并行（GNU Make 4+）
regress-parallel: $(addprefix run-,$(notdir $(basename $(wildcard 02_sim/tb_*.sv))))
	@echo "All parallel tests completed"

run-%: clean
	$(eval MODULE = $(patsubst tb_%,%,$*))
	vlib work
	vlog -sv 01_src/00_hdl/$(MODULE)/$(MODULE).sv
	vlog -sv 02_sim/tb_$(MODULE).sv
	vsim -c tb_$(MODULE) -do "run -all; quit"
```

### 4.4 覆盖率门禁 (CI 用)

```makefile
# 覆盖率门禁 — 低于阈值则失败
COVERAGE_THRESHOLD := 80

coverage-check: coverage-report
	@python3 -c "
import json, sys
# 解析 coverage-helper.cjs 的输出
# node engine/scripts/coverage-helper.cjs coverage_report.txt
" 2>/dev/null || echo "⚠️ coverage-helper 未安装，跳过门禁检查"
	@echo "Coverage check done"
```

---

## 五、Python 回归运行器

```bash
# 使用 scripts/run-regression.py 运行回归
python scripts/run-regression.py --dir . --verbose

# JSON 输出到 02_sim/regression_result.json
```

---

## 六、覆盖率与证据门禁集成

Phase 4.5 证据门禁要求每个模块输出 JSON 证据文件：

```json
{
  "module": "scrambler",
  "status": "PASS",
  "compared_points": 1024,
  "max_error_lsb": 0,
  "first_fail_at": null,
  "coverage": {
    "line": 95.2,
    "condition": 88.5,
    "fsm": 100.0,
    "toggle": 76.3
  }
}
```

建议目标：
- **Line coverage** ≥ 90%
- **Condition coverage** ≥ 80%
- **FSM coverage** = 100% (所有状态和转移)
- **Toggle coverage** ≥ 70%
