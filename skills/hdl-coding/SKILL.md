---
name: hdl-coding
description: HDL 编码规范 — Verilog/SystemVerilog FPGA 设计。时序安全、命名规范、代码结构、状态机、Lint 门禁。
version: 3.3.0
---

# HDL 编码规范

## 适用边界
**必须使用**: RTL 编写、Testbench、模块例化、时序约束。
**可跳过**: 纯文档/注释、已完成的代码审查（但 lint 仍需）。
**前置加载**: 编写 RTL 前必须先读 `references/RTL_DESIGN_RULE.md` 的 §代码对齐规范 和 §LUT/映射门禁。

---

## 必读红线（5 条 — 违反任何一条 = FAIL）
1. **[MUST]** 输入信号必须寄存为 `ri_`，禁止直通 → 否则 FAIL
2. **[MUST]** 输出必须由 `ro_` 驱动，禁止组合直出 → 否则 FAIL
3. **[MUST]** 同步复位高有效 `i_rst`，异步必须做同步释放 → 否则 FAIL
4. **[MUST]** `make lint` 通过后方可提交 → 否则 FAIL
5. **[MUST]** 三段式状态机 + `default` 分支 → 否则 FAIL

---

## §1 时序安全
1. 同步复位 — 高有效 `i_rst`；异步必须做同步释放
2. 输入寄存 — 所有输入在入口寄存为 `ri_`，禁止直通
3. 输出寄存 — 输出由 `ro_` 驱动，禁止组合直出
4. CDC — 异步输入双寄存同步，加 `_cdc` 后缀
5. 数据-使能对 — valid/enable 与数据成对传递
6. 无锁存器 — case→default、if→else、assign→完整条件
7. 时钟/复位配对 — `i_clk_xx` / `i_rst_xx` 配对出现，不得缺失

## §2 命名规范

### 前缀
- `i_` 模块输入 / `o_` 模块输出 / `ri_` 寄存输入 / `ro_` 寄存输出
- `r_` 内部寄存器 / `w_` 内部连线 / `P_` 参数/状态
- 时钟 `i_clk_xx`、复位 `i_rst`、跨时钟域 `_cdc`、数组 `_array`

### 例外
标准总线（AXI/Wishbone/JTAG）保持协议原名，不受前缀约束。

## §3 代码结构
```
模块声明 → 参数/P_ → 输入寄存/ri_ → 输出寄存/ro_ → 例化 → 状态机 → 组合逻辑 → 时序逻辑 → 数组
```
- 每模块 ≤300 行，每 always ≤50 行，控制/数据通路分离

## §4 状态机
- **[MUST]** 三段式（状态跳转 + 次态判断 + 输出），`localparam` 定义，`default` 必写
- 编码：≤5→二进制, 5~50→独热, >50→格雷（模板: `references/fsm-templates.md`）

## §5 位宽与符号
- 左右位宽必须匹配，禁止有/无符号混算，乘法器输出位宽 = 输入位宽之和

## §6 阻塞/非阻塞
- 时序逻辑 @posedge clk → `<=`，组合逻辑 → `=`
- **[MUST]** 禁止混用同一 always

## §7 工具使用
- **[MUST]** lint：提交前 `make lint` 通过，否则不得提交
- **[MUST]** 仿真：模块级功能仿真通过后再提交

---

## 参考文件
`skills/hdl-coding/references/` 下按需读取：

| 主题 | 文件 |
|:-----|:-----|
| 代码对齐细则 / LUT 映射门禁 | `RTL_DESIGN_RULE.md` |
| 三段式状态机模板 | `fsm-templates.md` |
| 流水线设计模板 | `pipeline-templates.md` |
| 存储器建模 | `memory-templates.md` |
| 异步复位同步释放 | `reset-templates.md` |
| Testbench 结构模板 | `tb-templates.md` |
| 除法器/LUT 技巧 | `division-lut.md` |
| RTL 审查清单 | `rtl-code-review.md` |
| 算法→Verilog 参考 | `alg-flow-verilog.md` |
| 注释规范 / 代码简化 | `comment-standards.md` / `simplification-guide.md` |

## 关联 Skill
- [code-review](../code-review/SKILL.md) — 代码审查
- [debugging](../debugging/SKILL.md) — 仿真调试
