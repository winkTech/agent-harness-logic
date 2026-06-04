---
name: hdl-coding
description: HDL 编码规范 — Verilog/SystemVerilog FPGA 设计。时序安全、命名规范、代码结构、状态机、Lint 门禁。
version: 3.1.0
---

# HDL 编码规范

## 适用边界

**必须使用**: RTL 编写、Testbench、模块例化、时序约束。
**可跳过**: 纯文档/注释、已完成的代码审查（但 lint 仍需）。

---

## §1 时序安全规则（最高优先级）

### 1.1 同步复位（默认）
- 使用高电平同步复位 `i_rst_n`（高有效，非低有效）
- 避免全局异步复位。若必须用异步复位→同步释放（见 `references/reset-templates.md`）

### 1.2 输入信号寄存
- 所有输入信号必须在模块入口寄存为 `ri_` 前缀
- 禁止直接使用未经寄存的输入信号

### 1.3 输出信号处理
- 避免组合逻辑直接输出
- 输出必须通过寄存器驱动（`ro_` 前缀）

### 1.4 跨时钟域处理
- 异步输入必须双寄存器同步
- 跨时钟域信号使用 `_cdc` 后缀

### 1.5 数据-使能对
- 数据必须与有效信号（valid/enable）成对传递
- 不允许"数据在那里就是有效的"假设

### 1.6 禁止锁存器
- case 必须有 default
- if-else 必须有 else
- assign 条件必须完整

---

## §2 命名规范

### 2.1 信号前缀（RTL）

| 前缀 | 含义 | 示例 |
|:----|:-----|:-----|
| `i_` | 模块输入 | `i_clk`, `i_data` |
| `o_` | 模块输出 | `o_result`, `o_valid` |
| `ri_` | 寄存后的输入 | `ri_data` |
| `ro_` | 寄存后的输出 | `ro_result` |
| `r_` | 内部寄存器 | `r_counter` |
| `w_` | 内部连线 | `w_sum` |
| `P_` | 参数/状态 | `P_IDLE`, `P_DATA_W` |

### 2.2 特殊信号
- 时钟: `i_clk_xx`（如 `i_clk_100m`）
- 复位: `i_rst_n`（高有效同步）
- 跨时钟域: `sig_cdc`
- 数组: `_array` 结尾

---

## §3 代码结构规范

```
模块声明和 I/O 定义
↓ 参数/状态定义（P_）
↓ 输入信号寄存（ri_）
↓ 输出信号寄存（ro_）和 assign
↓ 例化模块
↓ 状态机实现
↓ 组合逻辑
↓ 时序逻辑
↓ 数组赋值（放最后）
```

### 模块划分原则
- 每模块不超过 300 行
- 每个 always 块不超过 50 行
- 分离控制通路和数据通路
- **新建项目结构参考**: [cross-project-experience.md](../../knowledge/primary/cross-project-experience.md) 的 FPGA 项目模板

---

## §4 状态机设计

### 要求
- 采用**三段式**（状态跳转 + 次态判断 + 输出）
- 使用 `localparam` 定义状态
- 必须包含 `default` 分支

### 状态编码选择

| 状态数 | 编码 | 原因 |
|:------|:----|:-----|
| ≤5 | 二进制 | 节省寄存器 |
| 5~50 | 独热 | 译码简单、速度 |
| >50 | 格雷 | 减少翻转 |

→ 详细模板见 `references/fsm-templates.md`

---

## §5 位宽与符号

- 赋值左右位宽必须匹配
- 禁止有符号和无符号数混合运算
- 乘法器输出位宽 = 输入位宽之和
- 检查所有算术运算的位宽扩展

---

## §6 阻塞/非阻塞赋值

| 块类型 | 赋值 | 场景 |
|:------|:----|:-----|
| 时序逻辑 (posedge clk) | `<=` 非阻塞 | 所有寄存器 |
| 组合逻辑 | `=` 阻塞 | 中间计算 |
| **禁止** | 混用 | 同一 always 块 |

---

## §7 工具使用（必须执行）

### 7.1 语法检查
写/改完 RTL 后，提交前必须运行 lint:
```bash
iverilog -g2012 -t null <file>
```
**lint 未通过的代码不得提交。**

### 7.2 仿真验证
```bash
iverilog -g2012 -o sim.vvp <file>.v tb_<file>.v
vvp sim.vvp
```

---

## §8 设计检查清单

### 时序
- [ ] 同步复位（或异步→同步释放）
- [ ] 输入全部寄存
- [ ] 输出寄存器驱动
- [ ] CDC 双寄存器同步
- [ ] 无锁存器

### 命名
- [ ] i_/o_/ri_/ro_/r_/w_ 前缀正确
- [ ] CDC 信号 `_cdc` 后缀
- [ ] P_ 参数前缀

### 代码质量
- [ ] case 有 default
- [ ] if-else 完整
- [ ] 位宽匹配
- [ ] 时序用 `<=`、组合用 `=`
- [ ] lint 通过

---

## 反模式

| 反模式 | 正确做法 |
|:------|:---------|
| 输入未寄存直接使用 | 全部 `ri_` 寄存 |
| 异步复位全局乱用 | 同步复位为主，必要时同步释放 |
| 组合逻辑直接输出 | 输出寄存 |
| CDC 未处理 | 双寄存器 + `_cdc` 后缀 |
| 锁存器（case 无 default） | 所有分支都有默认值 |
| 2^n 以外的除/模运算 | initial LUT 预计算（见 `references/division-lut.md`） |
| 同一信号同时清零和置位 | 检查 if-else 优先级 |

## 详细参考

| 主题 | 文档 |
|:----|:-----|
| ~~RTL_DESIGN_RULE~~ | `references/RTL_DESIGN_RULE.md`（已融合到本规范） |
| 三段式状态机模板 | `references/fsm-templates.md` |
| 流水线设计模板 | `references/pipeline-templates.md` |
| 存储器建模 | `references/memory-templates.md` |
| 异步复位同步释放 | `references/reset-templates.md` |
| Testbench 结构模板 | `references/tb-templates.md` |
| 除法器/LUT 技巧 | `references/division-lut.md` |
| 注释规范与模块头 | `references/comment-standards.md` |
| RTL 审查详细清单 | `references/rtl-code-review.md` |
| 代码简化规范 | `references/simplification-guide.md` |

## 关联Skill

- [code-inspect](../code-inspect/SKILL.md) — 代码审查门禁
- [debugging](../debugging/SKILL.md) — 仿真异常调试
