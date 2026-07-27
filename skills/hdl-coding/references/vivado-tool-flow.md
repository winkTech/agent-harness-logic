# Vivado 工具流与自动化（Agent 可执行版）

> 目标：让 Agent **真跑工具拿证据**，而不是靠读代码猜综合结果。
> 语言级规则见 `vivado-synthesis-ug901.md`，方法学见 `ug949-rtl-methodology.md`。
>
> **核心原则**：RTL 的正确性靠仿真证明，RTL 的**可综合性与性能**只能靠 Vivado 报告证明。
> 「我读了代码觉得能推出 BRAM」不是证据；`report_utilization` 里的 BRAM 块数才是。

---

## §0 先探测工具链

```bash
node engine/scripts/eda-detect.cjs --json
```
返回可用工具与版本（`vivado` / `xvlog` / `xelab` / `xsim` / `vlog` / `vsim` / `verilator` / `iverilog` …）。

| 探测结果 | Agent 应该做什么 |
|:---------|:-----------------|
| `vivado` 可用 | 走本文全套流程，产出真实报告 |
| 仅 `xvlog`/`xelab`/`xsim` 可用 | 能做仿真，**不能**做综合级判断 → 综合结论一律标注"未验证" |
| 仅 `verilator`/`iverilog` | 只能 lint + 仿真；所有 Vivado 相关结论标注"未验证" |
| 都不可用 | **[MUST]** 明确声明"无 EDA 环境，以下为静态分析推断"，禁止把推断写成结论 |

---

## §1 执行入口：`vivado-flow` 技能

**跑 Vivado 的唯一入口是 `skills/vivado-flow/scripts/vivado_flow.tcl`**，完整用法见
`skills/vivado-flow/SKILL.md`。本文只讲「跑出来的东西怎么读、怎么判」。

> 2026-07-27 收敛：本技能原先自带两个 TCL 脚本（vivado_rtl_check / vivado_synth_report），
> 功能是 `vivado_flow.tcl` 的 `rtlcheck` / `synth` 两阶段的子集。
> 两套并存必然漂移（改门禁阈值只会改一边），已删除，全部指向 vivado-flow。

一条命令覆盖体检与综合（`rtlcheck` 是 elaborate 级、秒~分钟，**每次 RTL 改动后都该跑**）：

```bash
vivado -mode batch -nojournal -nolog \
  -source skills/vivado-flow/scripts/vivado_flow.tcl \
  -tclargs -top top -part xc7a100tcsg324-2 \
           -src 01_src/00_hdl -xdc 03_xdc -out 04_prj \
           -from rtlcheck -to synth
```

只体检不综合就 `-to rtlcheck`；综合失败修完后 `-from opt -to route` 从 DCP 续跑。

---

## §2 报告与判定

产出在 `<out>/rpt/`，各报告回答的问题：

| 报告 | 回答什么问题 | 对应规则 |
|:-----|:-------------|:---------|
| 利用率报告 | LUT/FF/BRAM/DSP 用了多少？**推断成功了吗？** | UG949 §4 Know What You Infer |
| 时序摘要 | WNS/TNS 多少？关键路径在哪？ | `timing-constraints.md` |
| `*_methodology.rpt` | 违反了哪条官方方法学？ | UG949 §8 |
| `*_cdc.rpt` | 跨时钟域有没有漏同步？ | UG949 §7.2 / 红线 3 |
| 时钟网络 / 时钟交互 | 时钟走全局布线吗？有门控时钟吗？域间约束全吗？ | UG949 §7.1 |
| 控制集 | 控制集数量是否导致打包失败？ | UG949 §2 |
| 高扇出网 | 哪些网扇出过高？ | UG949 §5 |
| QoR 建议 | 工具建议改哪里（含可 apply 的 TCL） | UG949 §8.2 |
| **`flow_summary.json`** | **结构化摘要 —— Agent 的唯一判定入口** | — |

`flow_summary.json` 是**按阶段分段**的嵌套结构：

```json
{ "ok": true, "stages_run": ["rtlcheck","synth"], "io_constrained": false,
  "rtlcheck": { "critical": 0, "error": 0, "items": [], "waived": [] },
  "synth":    { "wns": 2.890, "whs": 0.147,
                "lut": 1, "ff": 20, "bram": 1, "uram": 0, "dsp": 0, "srl": 0,
                "control_sets": 3, "cdc_critical": 0, "critical": 0, "error": 0,
                "items": [], "waived": ["Critical Warning/NSTD-1#1"] },
  "route": null, "skipped_reports": [], "blocking": [] }
```

**判定**：顶层 `ok: false` → **阻断**（退出码同步：0 通过 / 1 门禁阻断 / 2 用法或环境错误）。
`blocking[]` 给具体阻断项；`skipped_reports[]` 是本机 Vivado 版本不支持而跳过的报告，**不算失败**。

### 2.0 IO 布局规则的自动豁免

`NSTD-1`（未指定 IOSTANDARD）/ `UCIO-1`（未指定 PACKAGE_PIN）是"设计还没绑板子"的必然产物，
不是 RTL 缺陷。脚本按 XDC 里有没有 `PACKAGE_PIN` 自动判断：

- XDC **无** `PACKAGE_PIN` → `io_constrained: false`，这两条记入该阶段 `waived[]` 但**不阻断**；
- XDC **有** `PACKAGE_PIN`（面向真实板卡的顶层）→ 正常计入 `critical`，**阻断**。

`waived[]` 始终如实呈现，不是静默吞掉。做模块级评估时看到它属正常。

> **已实测**（Vivado 2023.1.1 win64，Artix-7，含 BRAM 推断的模块）：
> `-from rtlcheck -to synth` → exit 0 / `RESULT: PASS`，BRAM 推断成功（`bram=1`），WNS 2.890ns；
> `-from opt -to route` 读 `post_synth.dcp` 续跑三阶段 → route 后 WNS 2.800ns / WHS 0.081ns /
> 功耗 0.111W；`-cfg` 配置文件路径同样验证通过。

### 2.1 解析报告

harness 已有确定性解析器，**不要让 Agent 用眼睛读 .rpt 然后复述数字**：

```bash
node engine/scripts/fpga-util-parser.cjs   04_prj/rpt/utilization.rpt   --json
node engine/scripts/fpga-timing-parser.cjs 04_prj/rpt/timing_summary.rpt --json
node engine/scripts/fpga-xdc-parser.cjs    03_xdc/top.xdc                    --json
```

`engine/scripts/auto-parse-fpga-reports.cjs` 是 PostToolUse(Bash) hook：
检测到 `vivado`/`vsim`/`synth` 类命令成功后会自动在 `.`、`02_sim/`、`04_prj/` 下找报告并解析摘要，
**所以报告输出目录建议放在 `04_prj/rpt/`**，否则 hook 抓不到。

---

## §3 完整实现流程（非工程模式 TCL）

需要跑到布线/比特流时用。非工程模式（Non-Project Mode）适合脚本化和版本控制。

```tcl
# ── 读入 ──
read_verilog -sv [glob 01_src/00_hdl/*/*.sv]
read_xdc      03_xdc/top.xdc

# ── 综合 ──
synth_design -top top -part xc7a100tcsg324-2 -flatten_hierarchy rebuilt
write_checkpoint -force 04_prj/post_synth.dcp
report_utilization     -file 04_prj/rpt/post_synth_util.rpt
report_timing_summary  -file 04_prj/rpt/post_synth_timing.rpt
report_methodology     -file 04_prj/rpt/post_synth_methodology.rpt

# ── 实现 ──
opt_design
place_design
phys_opt_design
route_design
write_checkpoint -force 04_prj/post_route.dcp
report_timing_summary  -file 04_prj/rpt/post_route_timing.rpt
report_utilization     -file 04_prj/rpt/post_route_util.rpt
report_drc             -file 04_prj/rpt/post_route_drc.rpt
report_power           -file 04_prj/rpt/power.rpt

# ── 比特流 ──
write_bitstream -force 05_bin/top.bit
```

常用综合选项：

| 选项 | 作用 |
|:-----|:-----|
| `-flatten_hierarchy none/rebuilt/full` | `rebuilt`（默认）跨层次优化后重建层次，便于分析 |
| `-directive AreaOptimized_high` / `PerformanceOptimized` | 综合策略 |
| `-retiming` | 自动寄存器重定时（能救一部分时序，但会打乱信号名） |
| `-mode out_of_context` | 模块级独立综合（做 CBB 资源/时序评估时用） |
| `-rtl -rtl_skip_mlo` | 只 elaborate 不综合（§1 的 RTL DRC 流程） |

> **模块级评估技巧**：给单个 CBB 做资源/Fmax 评估，用 `-mode out_of_context` +
> 一份只含 `create_clock` 的 XDC，几十秒就能拿到该模块的 LUT/FF/BRAM/DSP 和 Fmax，
> 不需要搭完整顶层。这是 `engineering-assets` 里 CBB 准入评估的推荐做法。

---

## §4 xsim 仿真流程

Vivado 自带仿真器，无 Questa 时的默认选择。

```bash
# 1. 编译（SystemVerilog 必须加 -sv）
xvlog -sv -L uvm 01_src/00_hdl/<mod>/<mod>.sv 02_sim/<mod>/tb_<mod>.sv

# 2. 精化（-debug typical 才能 dump 波形；跑 UVM 加 -L uvm)
xelab -debug typical -top tb_<mod> -snapshot tb_<mod>_snap

# 3. 运行
xsim tb_<mod>_snap -runall
# 或带 TCL 批处理（波形/断点）
xsim tb_<mod>_snap -tclbatch 02_sim/xsim_run.tcl
```

`02_sim/xsim_run.tcl` 最小内容：
```tcl
log_wave -recursive *
run all
exit
```

注意事项：

- **[MUST]** `xvlog` 编译 `.sv` 必须带 `-sv`，否则按 Verilog-2001 解析，`logic`/`always_ff` 全报错；
- xsim 的编译产物在 `xsim.dir/`、`*.pb`、`*.wdb`、`xvlog.log`/`xelab.log` —— **必须进 `.gitignore` 和 `make clean`**；
- xsim 对 SVA 的支持弱于 Questa，断言失败信息较简略；
- 波形 `.wdb` 用 `vivado -mode gui` 打开，或 `xsim --gui`。

---

## §5 单条命令速查（在已打开的设计上）

| 命令 | 用途 |
|:-----|:-----|
| `report_utilization -hierarchical` | 逐层次资源，定位是哪个模块吃了资源 |
| `report_timing -max_paths 10 -nworst 1 -path_type full_clock_expanded` | 看最差 10 条路径的完整时钟路径 |
| `report_timing_summary -delay_type min_max -report_unconstrained` | **`-report_unconstrained` 必加** — 未约束路径是最常见的假绿灯 |
| `report_methodology` | 官方方法学检查 |
| `report_drc -ruledecks {default}` | 设计规则检查 |
| `report_cdc -details` | 跨时钟域检查 |
| `report_clock_networks` | 时钟树结构（查门控时钟/局部布线） |
| `report_clock_interaction` | 时钟域两两之间的路径与约束状态 |
| `report_control_sets -verbose` | 控制集统计（查 FF 打包失败） |
| `report_high_fanout_nets -fanout_greater_than 200` | 高扇出网 |
| `report_qor_suggestions` | 工具给的改进建议（可 `write_qor_suggestions` 导出 TCL） |
| `report_qor_assessment` | QoR 总评分（1~5，<3 说明设计有系统性问题） |
| `report_ram_utilization` | BRAM/URAM 使用细节（查推断与吸收） |
| `report_power -hierarchical` | 逐层次功耗 |
| `check_timing -verbose` | 约束完整性（无时钟/无 IO 延迟的端口） |

---

## §6 Agent 使用纪律

### 6.1 三条硬规则

1. **[MUST] 不跑工具就不下综合结论。** 没有 `report_utilization` 就不许说"资源够用"；
   没有 `report_timing_summary` 就不许说"时序能收敛"；没有 `report_cdc` 就不许说"CDC 没问题"。
   无工具环境时明确写"未验证（无 EDA 环境）"。
2. **[MUST] 数字来自解析器，不来自复述。** 用 `fpga-util-parser.cjs` / `fpga-timing-parser.cjs`
   输出 JSON，把 JSON 里的值写进报告。人工从 .rpt 里抄数字是本仓库已记录的错误来源。
3. **[MUST] 报告落到 `04_prj/rpt/`**，让 `auto-parse-fpga-reports.cjs` hook 能自动抓取，
   并保证证据可被后续阶段复查。

### 6.2 什么阶段跑什么

| 阶段 | 跑什么（均为 `vivado_flow.tcl`） | 阻断条件 |
|:-----|:-------|:---------|
| RTL 编码后（Phase 4） | `-to rtlcheck` | `rtlcheck.critical > 0` |
| 模块验证通过后 | `-mode ooc -to synth` 单模块评估 | 资源超 `resource_budget_tracking.md` 预算 10% |
| 顶层集成后（Phase 5/6b） | `-from rtlcheck -to synth` | `ok: false`；`synth.cdc_critical > 0`；methodology critical > 0 |
| 需要实现级数据 | `-from opt -to route` | `route.wns < 0` |
| 出板级产物 | `-to bitstream` | 同上 |

### 6.3 Windows 上的调用

`vivado` 在 Windows 上是 `.bat` 包装器。`eda-detect.cjs` 已处理 `.bat/.cmd` 后缀解析；
在 Bash 工具里直接 `vivado -mode batch ...` 即可，路径用正斜杠。
TCL 脚本里所有路径也用正斜杠（Vivado TCL 跨平台统一用 `/`）。

### 6.4 清理

Vivado 产生的 transient 文件必须进 `make clean` 与 `.gitignore`：
```
vivado*.jou vivado*.log vivado*.str .Xil/
xsim.dir/ *.wdb *.pb xvlog.log xelab.log xsim.log webtalk*.jou webtalk*.log
04_prj/*.cache/ 04_prj/*.hw/ 04_prj/*.runs/ 04_prj/*.sim/ .srcs/
```
（`-nojournal -nolog` 能挡掉 `.jou`/`.log`，但 `.Xil/` 仍会生成。）

---

## §7 官方模板资源

- **Vivado IDE → Window → Language Templates**：官方推断模板（RAM/ROM/SRL/DSP/FSM/XPM/IO/CDC），
  权威且随版本更新；UG901 的编码示例也提供文件下载。
- **XPM 宏**：`xpm_cdc_*`（CDC）、`xpm_memory_*`（RAM/ROM/FIFO）、`xpm_fifo_*`。
  用 XPM 的好处是工具能识别、`report_cdc` 自动豁免、参数化程度高。
  例化前在 TCL 里 `set_property XPM_LIBRARIES {XPM_CDC XPM_MEMORY XPM_FIFO} [current_project]`
  （非工程模式下 Vivado 2019.2+ 自动可用）。

---

## 相关文件

- 执行入口: `skills/vivado-flow/SKILL.md` + `skills/vivado-flow/scripts/vivado_flow.tcl`
- 配置模板: `skills/vivado-flow/templates/flow.cfg`
- 解析器: `engine/scripts/fpga-util-parser.cjs`、`fpga-timing-parser.cjs`、`fpga-xdc-parser.cjs`
- 探测: `engine/scripts/eda-detect.cjs`
- 语言级/方法学: `vivado-synthesis-ug901.md`、`ug949-rtl-methodology.md`
- 约束: `timing-constraints.md`
