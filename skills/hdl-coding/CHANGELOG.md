# hdl-coding 变更日志

## v3.6.0 (2026-07-26) — 审计修复

- **红线统一**：红线 5 改为"无锁存器"（与 `rules/01-hdl.md` 对齐）；原"仿真报错排查顺序"保留在 §7，不再占用红线位
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
  - `comm/axis_pipeline_reg.sv`、`comm/pipe_delay.sv`：generate 循环变量 `integer i` → `genvar i`（IEEE 1800 要求）
  - `internet/crc.sv`：解除 `crc_32_right`/`crc_32_left` 在 `crc32` 内的模块嵌套（嵌套模块工具支持度差，iverilog 无法解析 `crc_32_left`）；修复后两个叶子模块经公开校验值仿真验证 bit-true（CRC-32/IEEE `0xCBF43926`、CRC-32/BZIP2 `0xFC891918`）
  - `alu/alu_4bit_16func.v`：`reg [4:0] C` 同时被 always 块（C[0]）和例化端口（C[4:1]）驱动 → 拆分为 `C0` + `C_chain` 合成只读 wire；修复后 A/B/Ci 全穷举 × 9 功能码对照行为级模型仿真通过
  - 修复后 20 个模板 iverilog 全量 elaboration 零错误

## v3.0 – v3.5

- 精简重构：主文件只保留规范与索引，详细内容拆分至 `references/`（按需读取）与 `templates/`（按域组织）
- 与 `rules/01-hdl.md` 建立 L1 摘要分层：rules 提供常驻红线摘要，SKILL.md 提供完整规范

## v1.0 – v2.14 (2026-05-30)

- 初始版本建立时序安全、命名、代码结构、状态机、复位等核心规范
- v2.x 曾按资料书目扩展至 31 章并附 6 个完整 example 项目（async_fifo、picorv32、verilog-pcie 等）；该形态已在 v3.x 重构中整体移除，详细历史见 git 历史中本文件的旧版本
