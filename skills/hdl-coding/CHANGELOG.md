# hdl-coding 变更日志

## v3.8.0 (2026-07-27) — Vivado 执行入口收敛到 vivado-flow 技能

**动机**：v3.7 在本技能下加的两个 TCL 脚本（vivado_rtl_check / vivado_synth_report，已删除），
功能是 `vivado-flow` 技能里 `vivado_flow.tcl` 的 `rtlcheck` / `synth` 两个阶段的**子集**。
两套 Vivado 入口并存必然漂移——改门禁阈值、加豁免规则只会改到一边，另一边悄悄过期。

- **删除** 本技能 templates 下的 tcl 子目录（两个脚本连同目录一并移除）
- **执行入口统一为** `skills/vivado-flow/scripts/vivado_flow.tcl`。它多出的能力：
  opt/place/route/bitstream 全流程、逐阶段存 DCP 断点续跑、`-cfg` 配置文件、`.f` filelist、
  器件型号预检、Versal 自动切 `write_device_image`
- **证据格式变更**：`rtl_check_summary.json` + `synth_report_summary.json`（两个扁平 JSON）
  → `flow_summary.json`（单个按阶段分段的嵌套 JSON）。判定改看顶层 `ok` 字段
- **同步改指的文件**：本技能 SKILL.md §10 / 代码模板表、`references/vivado-tool-flow.md` §1 §2 §6.2 §相关文件、
  `references/ug949-rtl-methodology.md` §8、`docs/rules/01-hdl.md`、`agents/domain/logic-engineer.md`
  （工具箱 + 防线 6 + 挂载 `vivado-flow` 技能）、`skills/workflows/hdl-coding-workflow.md`、
  `skills/workflows/hdl-coding/phase7-code-review.md`
- **工作流 Phase 6b 重写**（`workflows/hdl-coding-dag-workflow.js` v3.7.1 + `.claude/` 镜像）：
  两条命令合并为一条，schema 换成 flow_summary 字段（`ok` / `stages_run` / `synth.*` / `waived_items` /
  `skipped_reports`），阻断条件加入"脚本自身判定 ok=false"与"存在推断失败项"，
  失败提示补上"可 `-from opt -to route` 续跑，不必重综合"
- `hdl-coding` 现在只管**怎么写**（规则、推断模板、综合属性），`vivado-flow` 管**怎么跑、拿什么证据**

## v3.7.0 (2026-07-27) — Xilinx 官方方法学接入（UG901 / UG949 / UG1192）

**动机**：仓库此前对 Vivado 的覆盖是空白 —— 全库检索 `RAM_STYLE` / `USE_DSP` / `ASYNC_REG` /
`DIRECT_ENABLE` / `report_methodology` / `report_cdc` 只有零星散提，没有属性表、没有推断规则、
没有任何可执行的工具流。红线管得住功能正确性，管不住**推断静默失败**（RTL 仿真全对、综合完
BRAM 用了 0 块、DSP 没吸收流水寄存器、Fmax 掉一半，工具不报任何错）。

- **新增 `references/vivado-synthesis-ug901.md`**（语言级）：SystemVerilog 可综合子集允许/禁止清单、
  各类硬件推断模板与破坏推断的写法、BRAM 读写同步模式、`RAM_STYLE`/`SRL_STYLE`/`USE_DSP` 等
  **20 条综合属性速查表**、以及与本仓库五条红线的交叉点 + **复位豁免清单（§5.1）**
- **新增 `references/ug949-rtl-methodology.md`**（方法学级）：层次划分、控制集与 FF 打包、
  复位/时钟使能优先级陷阱（FDRE 的 R 受 CE 门控）、**Know What You Infer**（BRAM 输出寄存器
  吸收失败三条件、UltraRAM 映射约束、DSP 流水、SRL）、提升 Fmax / 降功耗的编码风格、
  时钟与 CDC checklist（含 XPM_CDC 宏表）、RTL DRC 违规家族 ↔ 本仓库规则对照
- **新增 `references/vivado-tool-flow.md`**（工具级，Agent 可执行）：`eda-detect` 探测分支决策、
  RTL DRC 秒级体检、综合后全套报告与它们各自回答什么问题、非工程模式 TCL 实现流程、
  `-mode out_of_context` 单模块/CBB 评估、xsim 编译仿真流程、25 条 `report_*` 命令速查、
  **Agent 使用纪律（不跑工具不下综合结论 / 数字来自解析器 / 报告落 `04_prj/rpt/`）**
- **新增 templates/tcl/vivado_rtl_check.tcl**（**已于 v3.8.0 删除，见上**）：elaborate 级体检，跑 `report_drc` +
  `report_methodology`，用对象 API（`get_drc_violations` / `get_methodology_violations`）统计
  严重度，输出 `rtl_check_summary.json` + `RESULT: PASS/FAIL` + 退出码
- **新增 templates/tcl/vivado_synth_report.tcl**（**已于 v3.8.0 删除，见上**）：综合后产出 11 份报告 +
  `synth_report_summary.json`（WNS/WHS、LUT/FF/BRAM/URAM/DSP/SRL 实际单元数、控制集数量、
  DRC/methodology/CDC 三类违规计数、阻断项清单）
- **SKILL.md 新增 §10 Vivado 综合可预测性**：三条硬要求（不跑工具不下综合结论 / RTL 改动后跑
  RTL DRC / 顶层集成后跑全套报告）、推断静默失败的四种高危写法、属性使用纪律；§7 增补综合级
  结论的证据要求；前置加载增加触发条件
- **工作流接入**：`hdl-coding-dag-workflow` 新增 `p6b_vivado_check` 节点（Phase 6b），与回归/审查
  并行，产出综合级证据供 Phase 8 与 Verifier 交叉核对
- **agent 接线**：`logic-engineer` 工具箱补齐 Vivado 命令与两个 TCL 脚本，context_files 加载三份新参考

## v3.6.0 (2026-07-26) — 审计修复

- **红线统一**：红线 5 改为"无锁存器"（与 `docs/rules/01-hdl.md` 对齐）；原"仿真报错排查顺序"保留在 §7，不再占用红线位
- **去重**：合并红线与 §1 的重复表述（重复的"烧过板"论述、§1 与红线逐条重复的规则文本）
- **修正论断**：复位规则的理由改为"目标器件（Xilinx 类架构）推荐 + 项目统一约定"，不再声称"低有效复位会被工艺库优化掉/高有效是业界统一标准"；description 中"不能综合"改为"无法通过审查门禁"
- **§9 收窄**：计划确认只适用于新模块/架构级/跨模块任务，已有文件的明确小修复直接做（与 CLAUDE.md 授权边界一致）
- **前置加载收窄**：§LUT/映射门禁只在涉及映射/查找表/编码表时必读
- **索引补全**：参考文件表补入 `tb-scoreboard.md`、`axi_stream_if.sv`、`axi-stream-vip.sv`、`coverage-templates.md`、`timing-constraints.md`、`fpga-optimization.md`、`fpga-development.md`、`design-best-practices.md`、`alu-design.md`、`algorithm-hardware.md`；新增"代码模板"一节索引 `templates/`
- **模板标注**：`templates/alu/`、`templates/internet/` 共 11 个外源模板补齐元数据头，并标注"命名未按 ri_/ro_ 规范，复用前必须按 §1/§2 重写"
- **死引用修复**：`RTL_DESIGN_RULE.md` 中指向不存在的 `phase-reflection.md` 的引用改为指向项目 Golden Model
- **evals 修复**：`always @(posedge i_clk)` 等断言的括号按 regex 转义（原写法作为正则永远匹配不到真实代码）；新增红线 1/2/4/5 的断言（ri_/ro_/default/组合段）；版本号与技能对齐
- **资产清理**：删除 `examples/`（仅剩一个 0 字节孤儿 PDF）；`matlab-rule.md`、`toolchain.md` 迁至 `engineering-assets/knowledge/references/`（非 HDL 编码规范内容）
- **模板 RTL 缺陷修复**（验证阶段用 iverilog 全量编译发现的预存缺陷）：
  - `templates/comm/axis_pipeline_reg.sv`、`templates/comm/pipe_delay.sv`：generate 循环变量 `integer i` → `genvar i`（IEEE 1800 要求）
  - `templates/internet/crc.sv`：解除 `crc_32_right`/`crc_32_left` 在 `crc32` 内的模块嵌套（嵌套模块工具支持度差，iverilog 无法解析 `crc_32_left`）；修复后两个叶子模块经公开校验值仿真验证 bit-true（CRC-32/IEEE `0xCBF43926`、CRC-32/BZIP2 `0xFC891918`）
  - `templates/alu/alu_4bit_16func.v`：`reg [4:0] C` 同时被 always 块（C[0]）和例化端口（C[4:1]）驱动 → 拆分为 `C0` + `C_chain` 合成只读 wire；修复后 A/B/Ci 全穷举 × 9 功能码对照行为级模型仿真通过
  - 修复后 20 个模板 iverilog 全量 elaboration 零错误

## v3.0 – v3.5

- 精简重构：主文件只保留规范与索引，详细内容拆分至 `references/`（按需读取）与 `templates/`（按域组织）
- 与 `docs/rules/01-hdl.md` 建立 L1 摘要分层：rules 提供常驻红线摘要，SKILL.md 提供完整规范

## v1.0 – v2.14 (2026-05-30)

- 初始版本建立时序安全、命名、代码结构、状态机、复位等核心规范
- v2.x 曾按资料书目扩展至 31 章并附 6 个完整 example 项目（async_fifo、picorv32、verilog-pcie 等）；该形态已在 v3.x 重构中整体移除，详细历史见 git 历史中本文件的旧版本
