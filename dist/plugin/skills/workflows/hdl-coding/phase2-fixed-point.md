# Phase 2: 定点量化与资源评估

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 用数据驱动的方式确定位宽、量化策略和资源预算，杜绝经验估算。

## 2.1 资源目标确认

- 基于 Phase 1.4 的初步预算，确认各模块资源上限
- 如有严格资源要求，在量化阶段就纳入约束

## 2.2 位宽扫描与量化分析

- 各节点从高到低逐级缩减位宽，观察 BER/EVM 退化
- 统计各节点动态范围，确定整数位宽
- 量化策略选择比较：截断(truncation) / 四舍五入(rounding) / 饱和(saturation)
- 量化误差报告：各节点 SNR 退化、最大误差、MSE 汇总

## 2.3 Bit-true 定点模型

- MATLAB `fi()` 重构定点模型
- 用独立浮点基线实测量化误差并对照设计限值；位真参考明确舍入、溢出、缩放和饱和规则，供后续整数向量逐比特比较。
- 对离散判决，用独立参考验证相等及相邻输入的取舍。例如 Viterbi ACS 要构造两条等度量路径，并分别使两侧领先一个量化单位；记录输入、参考选择、实测选择和首次分歧。系统回环 BER 用于整链验收，模块定向样例用于证明这条分支实际运行过。

## 2.4 星座/LUT 映射验证（涉及 LUT 查表时执行）

涉及星座映射、查找表、比特-符号映射的模块必须额外执行：

- **映射公式推导文档化**：从 MATLAB `cnstPattern`/`bi2de` 到 RTL 比特索引的完整推导
- **逐点验证**：对所有可能索引值（如 64QAM 的 64 点）逐一比对 MATLAB 与定点模型的输出
- **固定序列交叉检查**：选 3~5 个已知输入手动核算 I/Q 值
- **输出**: `mapping_verification_report.md`（附验证截图/数据）

> 验证方法示例：MATLAB 输出 `cnstPattern(mapIdx)` → 定点模型输出经 Q(16,9) 缩放后的十六进制值 → 确认与 RTL 预期一致。

## 2.4 资源评估

- DSP/LUT/BRAM 预算表（基于定点结果 + 架构框图，非经验估算）
- 若超标 → 回退 2.2 调整位宽，或回退 Phase 1 调整架构
- 输出架构缩放建议

## 检查点

fixed_point_report + resource_estimate 完成，资源预算在约束内。

**参考**: `skills/hdl-coding/references/alg-flow-verilog.md`（Python 定点函数）, `packs/fpga/engineering-assets/knowledge/docs/templates/fixed_point_report_template.md`, `packs/fpga/engineering-assets/knowledge/docs/templates/resource_estimate_template.md`
**输出**: `06_doc/fixed_point_report.md` + `06_doc/resource_budget_tracking.md`

在项目中生成 `var/workflow/p2-fixed-point.json`，再从插件根执行 `node core/engine/scripts/hdl-evidence-gate.cjs --project-root "<项目>" --fixed-point --modules a,b`。完整模式在该门禁通过后才生成最终整数向量。

- `modules` 以目标模块名为键，每项含 `model`（实际位真模型）、`reference`（独立参考或已知答案）、`measurement`（实跑输出 JSON）的项目相对路径。
- 每份测量记录含 `module, compared_points, selected_width, max_error_limit, rounding, overflow, trials`。每个 trial 含整数总位宽 `width` 和按相同单位测出的非负 `max_error`。限值来自项目验收条件。规格固定了唯一位宽时填写 `fixed_width_basis` 说明依据。定点报告记录 Q 格式、小数位、缩放、各工况误差和适用边界。
- `resources` 的 `DSP, LUT, BRAM` 每项记录非负 `estimate` 和 `limit`。尚无器件上限时填写 `null` 并说明估算范围。超过已定上限时，`acceptedRisk` 指向本次已获准的风险处置记录，否则返回设计审查。
- 用户已指定硬上限时，从送审条件填写工作流参数 `resourceLimits`，用同一资源单位计量。手动运行 P2 与 P4 门禁时逐项传 `--hard-limit DSP=20500` 等（数值取自实际项目）。硬上限由调用方提供，即使测量回执放宽内部配额或附有风险处置记录，超过硬上限仍会阻断。此处核对定点阶段估算，器件实测在综合阶段完成。
- `hashes` 以项目相对路径为键，值为实际运行时文件的 SHA-256（小写十六进制）。覆盖架构、两份输出报告、逐模块模型、独立参考、测量文件以及实际使用的代码、系数和输入依赖。
- 任务指定已有 Golden 时，P2 和 P4 的完整模式命令都加 `--with-baseline`。把预检回执、范围文件和原入口纳入 hashes；`systemCases` 按已审范围的每个工况指向实跑测量 JSON。测量含 `case, source, oracleInputs, compared_points, checks`，每个检查记录 `metric, float, fixed` 和按设计约定的 `min` 或 `max`。用相同输入比较浮点和定点，保留 BER/EVM 等适用指标的计算口径与原始数据。 正常路径写 `source: "normal", oracleInputs: []`；注入真值的诊断另存。签收范围 `limits` 的每项指标均须报告，浮点和定点实测值都应满足原限值。
