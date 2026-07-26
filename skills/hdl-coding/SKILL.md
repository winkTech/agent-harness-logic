---
name: hdl-coding
description: HDL 编码规范 — 所有 FPGA/ASIC 相关的 Verilog/SystemVerilog 任务：编写 RTL 模块、Testbench、模块例化、流水线设计、CDC、状态机、代码审查、讲解 FPGA 架构原理、画 RTL 框图和架构图。用户说"写 Verilog/写 RTL/写模块/审查代码/讲FPGA/画架构"时触发。技能强制 ri_/ro_ 命名、时序安全、三段式FSM、锁存器预防——违反红线的代码无法通过本项目审查门禁。注意：纯 Python/MATLAB、安装工具、搜算法原理、写脚本等非 HDL 任务不要触发。
version: 3.6.0
---

# HDL 编码规范

## 适用边界
**必须使用**: RTL 编写、Testbench、模块例化、时序约束。
**可跳过**: 纯文档/注释、已完成的代码审查（但 lint 仍需）。
**前置加载**: 编写 RTL 前先读 `references/RTL_DESIGN_RULE.md` 的 §代码对齐规范；涉及星座映射、查找表、比特-符号编码的模块，再加读 §LUT/映射门禁。

---

## 必读红线（5 条 — 违反任何一条 = FAIL）

> 与 `rules/01-hdl.md` 的红线一一对应，两处必须保持同步。**为什么严格？** 组合直出的信号会把毛刺传播到下一级；未寄存的输入在布局布线后时序收敛困难；锁存器不会被 lint 报错，却导致上板功能随机失败。这些都是实际项目中烧过板的教训。

1. **[MUST]** 输入信号必须寄存为 `ri_`，禁止直通 → 否则 FAIL
2. **[MUST]** 输出必须由 `ro_` 驱动，禁止组合直出 → 否则 FAIL
3. **[MUST]** 同步复位高有效 `i_rst`，异步必须做同步释放 → 否则 FAIL
4. **[MUST]** 三段式状态机 + `default` 分支 → 否则 FAIL
5. **[MUST]** 无锁存器：if→else、case→default、assign→完整条件（排查法见 §8）→ 否则 FAIL

---

## §1 时序安全

红线 1、2、3、5 的展开理由与补充规则：

1. **同步复位**（红线 3）
   - *原因*：本项目目标器件（Xilinx 类 FPGA 架构）推荐同步高有效复位，统一极性避免混用出错；异步复位若不做同步释放，复位恢复时会产生亚稳态
2. **输入寄存**（红线 1）
   - *原因*：组合输入在时序分析中无明确起点，导致时序收敛困难
3. **输出寄存**（红线 2）
   - *原因*：组合输出 = 毛刺发射器，下游每级都可能采到错误值
4. **CDC** — 异步输入双寄存同步，加 `_cdc` 后缀（模板: `templates/comm/cdc_sync.sv`）
5. **数据-使能对** — valid/enable 与数据成对传递
6. **时钟/复位配对** — `i_clk_xx` / `i_rst_xx` 配对出现，不得缺失

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

## §7 工具使用与验证
- **[SHOULD]** lint：提交前 `make lint` 通过（lint 检查基础语法，但不检查锁存器/命名等关键问题，不可替代人工审查）
- **[MUST]** 仿真：模块级功能仿真通过后再提交
- **[MUST]** 仿真报错按顺序排查：先检查端口位宽匹配，再查时序，最后查逻辑
- **[SHOULD]** RTL 输出必须与 Golden Model bit-true 对齐，不允许用容差掩盖算法偏离

---

## §8 锁存器预防（红线 5 的排查法）

**为什么重要**：锁存器在 FPGA 中不会在 lint 报错，但会导致时序异常和功能随机失败——是最难调试的 bug 之一。大多数"仿真对了但上板不对"的案例，根因是组合逻辑推了 latch。

### 三段排查法

```
排查锁存器三步走：
1. always_comb 中所有分支都赋值了吗？→ if 要有 else，case 要有 default
2. 组合逻辑中读取的信号同时被赋值了吗？→ 那是组合反馈环
3. 某个信号只在特定条件下保持值？→ 一定推了 latch
```

### 典型违规模式

| 模式 | 代码片段 | 问题 |
|:-----|:---------|:-----|
| 缺 else | `if (cond) q = 1;` | `cond=0` 时 q 保持 → latch |
| 缺 default | `case(s) A: q=1; B: q=0; endcase` | 未覆盖分支 q 保持 → latch |
| 状态未全覆盖 | `case(s) IDLE: q=d; BUSY: q=q+1; endcase` | DONE 状态未覆盖 → latch |
| 组合反馈 | `always @(*) q = q + 1;` | 不经过触发器的组合环 → 震荡 |
| 自读自写 | `always @(*) result = result + data;` | 同一变量组合自指 → 环路 |

### 检查清单
- [ ] 每个 `always @(*)` 都有完整的条件分支（if→else, case→default）
- [ ] 组合逻辑中不存在信号自读自写？→ 有则改为时序 `<=`
- [ ] 组合 case 覆盖了所有可能的状态值？
- [ ] 输出端口由 ro_ 时序驱动，非组合逻辑直出？

---

## §9 工作流程
- **[SHOULD]** 新模块、架构级改动或跨模块任务：实施前先输出执行计划，与用户对齐后再编码
- 已有文件中行为明确的小修复：直接做范围内最小修改，无需计划确认（与 CLAUDE.md 授权边界一致）

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
| TB 记分板 + AXI-Stream VIP | `tb-scoreboard.md`（配套 `axi_stream_if.sv`、`axi-stream-vip.sv`） |
| 功能覆盖率模板 | `coverage-templates.md` |
| 时序约束（时钟/IO/例外） | `timing-constraints.md` |
| 资源与时序优化 | `fpga-optimization.md` |
| FPGA 开发流程与最佳实践 | `fpga-development.md` / `design-best-practices.md` |
| 除法器/LUT 技巧 | `division-lut.md` |
| RTL 审查清单 | `rtl-code-review.md` |
| 算法→Verilog 参考 | `alg-flow-verilog.md` |
| ALU/加法器设计 | `alu-design.md` |
| 常用算法硬件实现（CRC/哈希/CAM…） | `algorithm-hardware.md` |
| 注释规范 / 代码简化 | `comment-standards.md` / `simplification-guide.md` |

## 代码模板
`skills/hdl-coding/templates/` 下按域组织：

| 目录 | 状态 | 使用方式 |
|:-----|:-----|:---------|
| `comm/`（9 个：AXIS 主/从/流水寄存、CDC、复数乘、LFSR、延迟链、双口 RAM） | **符合本规范**（ri_/ro_/r_ 命名、元数据头） | 可直接例化或改造 |
| `alu/`（3 个）、`internet/`（8 个：CRC/哈希/LRU/CAM/帧同步/Crossbar/SM4） | **外部资料改编**，命名未按 ri_/ro_ 规范 | 仅参考算法结构；复用前必须按 §1/§2 重写接口与命名 |

## 关联 Skill
- [code-review](../code-review/SKILL.md) — 代码审查
- [debugging](../debugging/SKILL.md) — 仿真调试
