---
name: vivado-flow
description: Vivado 非工程模式全流程驱动 — 一条命令跑 RTL DRC → 综合 → 优化 → 布局 → 布线 → 比特流，逐阶段存 DCP 可断点续跑，产出 flow_summary.json 结构化证据（WNS/WHS/资源/方法学/CDC/功耗）。用于跑综合实现、拿时序资源数据、做 CBB 的 out-of-context 评估、以及"设计能不能收敛"这类必须有报告支撑的判定。只写 RTL 不跑工具时用 hdl-coding。
version: 1.0.0
---

# Vivado Flow — 非工程模式全流程驱动

**脚本**: `skills/vivado-flow/scripts/vivado_flow.tcl`（642 行，Vivado 2023.1 实测通过）

## 为什么用它

仿真只证明功能对，证明不了综合器把代码变成了什么。资源够不够、时序收不收敛、BRAM/DSP
推断成没成功 —— 这些只能靠 Vivado 报告。本脚本把整条流程脚本化，并把判定所需的数字
汇总成一个 JSON，**下游读 JSON，不要让人去 .rpt 里抄数字**。

## 调用

```bash
vivado -mode batch -nojournal -nolog \
  -source skills/vivado-flow/scripts/vivado_flow.tcl \
  -tclargs -top <顶层> -part <器件> -src <源目录> -xdc <约束目录> -out <输出目录> \
           -from <起始阶段> -to <结束阶段>
```

常用组合：

```bash
# RTL 体检（秒~分钟级，每次改完 RTL 都该跑）
... -tclargs -top top -part xc7a100tcsg324-2 -src 01_src/00_hdl -out 04_prj -from rtlcheck -to rtlcheck

# 综合 + 全套证据（顶层集成后）
... -tclargs -top top -part xc7a100tcsg324-2 -src 01_src/00_hdl -xdc 03_xdc -out 04_prj -from rtlcheck -to synth

# 综合失败修完后，从 DCP 续跑实现，不必重综合
... -tclargs -top top -part xc7a100tcsg324-2 -src 01_src/00_hdl -xdc 03_xdc -out 04_prj -from opt -to route

# 单个 CBB 的资源/Fmax 评估（只需一份 create_clock 约束）
... -tclargs -top rrc_polyphase_fir -part xc7a100tcsg324-2 -src rtl -xdc xdc -out out -mode ooc -to synth

# 出比特流
... -tclargs -top top -part xc7a100tcsg324-2 -src 01_src/00_hdl -xdc 03_xdc -out 04_prj -to bitstream
```

参数多时用配置文件，CLI 覆盖配置文件：

```bash
... -tclargs -cfg skills/vivado-flow/templates/flow.cfg -to route
```

## 阶段与产物

`-from` / `-to` 从下表取值，区间闭合。

| 阶段 | 做什么 | 产物 |
|:-----|:-------|:-----|
| `rtlcheck` | 只 elaborate，跑 RTL DRC + 方法学 | `rpt/rtl_drc.rpt`、`rtl_methodology.rpt` |
| `synth` | 综合 + 全套证据报告 | `dcp/post_synth.dcp` + 利用率/时序/方法学/CDC/控制集/扇出 |
| `opt` | `opt_design` | `dcp/post_opt.dcp` |
| `place` | 布局（+ `phys_opt_design`） | `dcp/post_place.dcp` + 布局后时序 |
| `route` | 布线 | `dcp/post_route.dcp` + 时序/DRC/功耗 |
| `bitstream` | 生成位流 | `bit/<top>.bit`；Versal 自动切 `write_device_image` 出 `.pdi` |

输出根目录默认 `04_prj`，下分 `rpt/` `dcp/` `bit/`。

> `rtlcheck` 建立的是 elaborate 后的设计，与综合不共存。同时要 rtlcheck 和 synth 时脚本
> 会自动分两趟跑，不需要手工拆命令。

## 判定：读 `rpt/flow_summary.json`

```json
{ "ok": true, "stages_run": ["rtlcheck","synth"],
  "synth": { "wns": 2.890, "whs": 0.147, "lut": 1, "ff": 20, "bram": 1, "dsp": 0, "srl": 0,
             "control_sets": 3, "critical": 0, "error": 0, "waived": ["Critical Warning/NSTD-1#1"] },
  "blocking": [] }
```

- **`ok: false` → 阻断。** 退出码同步：0 通过 / 1 门禁阻断 / 2 用法或环境错误
- `blocking` 列出具体阻断项；`waived` 是**如实呈现但不阻断**的豁免项
- `io_constrained: false` 时 `NSTD-1`/`UCIO-1`（未绑引脚）自动进 `waived` —— 模块级评估时属正常
- `skipped_reports` 列出本机 Vivado 版本不支持而跳过的报告，不当作失败

**推断核查**：设计里有存储器但 `bram=0 && uram=0`、有乘加但 `dsp=0`、有延时线但 `srl=0`
且 `ff` 远超预算 → 推断静默失败，属于要修的问题。规则见
`skills/hdl-coding/references/ug949-rtl-methodology.md` §4。

## 常用选项

| 选项 | 说明 |
|:-----|:-----|
| `-mode ooc` | out-of-context，单模块/CBB 独立评估，不需要完整顶层 |
| `-filelist <f>` | `.f` 清单（支持嵌套），给了就不扫 `-src` |
| `-define K=V` / `-incdir <dir>` / `-generic K=V` | 宏 / include 路径 / 顶层参数覆盖，可重复 |
| `-directive` / `-impl-directive` | 综合、布局布线策略 |
| `-jobs N` | 并行线程 |
| `-no-phys-opt` | 跳过 `phys_opt_design` |
| `-no-fail` | 跑完所有阶段再判定，不中途退出（想一次拿全部报告时用） |

## 使用纪律

- **[MUST] 不跑工具不下综合结论。** 没有 `flow_summary.json` 就不许说"资源够用/时序能收敛/CDC 没问题"，
  无 Vivado 环境时明确写"未验证"
- **[MUST] 数字取自 JSON**，不要从 `.rpt` 里人工抄
- **[MUST] 报告落在 `<out>/rpt/`**，`engine/scripts/auto-parse-fpga-reports.cjs` 这个
  PostToolUse hook 会自动抓取解析（它扫 `.`、`02_sim/`、`04_prj/` 的下级目录）
- 先 `node engine/scripts/eda-detect.cjs --json` 探测工具链再决定能下什么结论

## 与 hdl-coding 的分工

| 场景 | 用哪个 |
|:-----|:-------|
| 写 RTL / TB、命名与红线、推断规则、综合属性 | `hdl-coding` |
| 真跑 Vivado 拿资源/时序/方法学证据 | **本技能** |

`hdl-coding` 的三份 Vivado 参考仍是规则来源，本技能是执行入口：

- `skills/hdl-coding/references/vivado-synthesis-ug901.md` — 可综合子集 / 推断模板 / 综合属性
- `skills/hdl-coding/references/ug949-rtl-methodology.md` — Know What You Infer / 控制集 / Fmax / CDC
- `skills/hdl-coding/references/vivado-tool-flow.md` — report 命令速查与证据纪律

> **本技能是跑 Vivado 的唯一入口。** `hdl-coding` 早期自带的两个 TCL 脚本
> （vivado_rtl_check / vivado_synth_report）是本脚本 `rtlcheck` / `synth` 两阶段的子集，2026-07-27 已删除并
> 全部改指本技能 —— 两套并存必然漂移（改门禁阈值只会改一边）。
> HDL 工作流 Phase 6b 现在也调本脚本。

## 实测记录

Vivado 2023.1.1 (win64)，Artix-7 `xc7a100tcsg324-2`，含 BRAM 推断的测试模块：

| 命令 | 结果 |
|:-----|:-----|
| `-from rtlcheck -to synth` | exit 0，`RESULT: PASS`，BRAM 推断成功（`bram=1`），WNS 2.890ns |
| `-from opt -to route`（读 `post_synth.dcp` 续跑） | exit 0，三阶段全跑，route 后 WNS 2.800ns / WHS 0.081ns / 功耗 0.111W |
