---
name: hdl-coding
description: HDL 编码规范 — Verilog/SystemVerilog FPGA 设计。时序安全、命名规范、代码结构、状态机、Lint 门禁。
version: 3.2.0
---

# HDL 编码规范

## 适用边界
**必须使用**: RTL 编写、Testbench、模块例化、时序约束。
**可跳过**: 纯文档/注释、已完成的代码审查（但 lint 仍需）。
**前置加载**: 生成 RTL 代码前，先读取 `references/RTL_DESIGN_RULE.md` 获取完整编码规范。

---

## §1 时序安全（最高优先级）
| # | 规则 | 说明 |
|:-:|:-----|:-----|
| 1 | **同步复位** | 高有效 `i_rst`；必须异步→同步释放 |
| 2 | **输入寄存** | 所有输入在入口寄存为 `ri_`，禁止直通 |
| 3 | **输出寄存** | 输出由 `ro_` 驱动，禁止组合直出 |
| 4 | **CDC** | 异步输入双寄存器同步，加 `_cdc` 后缀 |
| 5 | **数据-使能** | valid/enable 与数据成对传递 |
| 6 | **无锁存器** | case→default、if→else、assign→完整条件 |
| 7 | **时钟/复位配对** | `i_clk_xx` / `i_rst_xx` 配对出现，不得缺失 |

## §2 命名规范

### 信号前缀
| 前缀 | 含义 | 示例 | | 前缀 | 含义 | 示例 |
|:----|:-----|:-----|:-:|:----|:-----|:-----|
| `i_` | 模块输入 | `i_data` | | `r_` | 内部寄存器 | `r_cnt` |
| `o_` | 模块输出 | `o_valid` | | `w_` | 内部连线 | `w_sum` |
| `ri_` | 寄存输入 | `ri_data` | | `P_` | 参数/状态 | `P_IDLE` |
| `ro_` | 寄存输出 | `ro_result` | | | | |

### 特殊信号 & 例外
- 时钟 `i_clk_xx`、复位 `i_rst`、跨时钟域 `_cdc`、数组 `_array`
- **接口例外**: AXI/Wishbone/JTAG 等标准总线保持协议原生命名

## §3 代码结构
```
// 模块声明 → 参数(P_) → 输入寄存(ri_) → 输出寄存(ro_) → 例化 → 状态机 → 组合逻辑 → 时序逻辑 → 数组
```
- 每模块 ≤300 行，每 always ≤50 行，分离控制/数据通路

## §4 状态机
- 三段式（状态跳转 + 次态判断 + 输出），`localparam` 定义，`default` 必写
- 编码: ≤5→二进制, 5~50→独热, >50→格雷（模板: `references/fsm-templates.md`）

## §5 位宽 & 符号
- 左右位宽匹配，禁止有/无符号混算，乘法器位宽 = 输入位宽之和

## §6 阻塞/非阻塞
| 时序逻辑 @posedge clk → `<=` | 组合逻辑 → `=` | **禁止混用同一 always** |

## §7 工具使用
- **lint**: 提交前 `make lint` 通过，否则不得提交
- **仿真**: 模块级功能仿真通过后再提交

---

## 参考文件（按需加载）

| 主题 | 文档 | 触发时机 |
|:-----|:-----|:---------|
| **详细编码规则** | `references/RTL_DESIGN_RULE.md` | **每次生成代码前自动加载** |
| 三段式状态机模板 | `references/fsm-templates.md` | 编写新状态机时 |
| 流水线设计模板 | `references/pipeline-templates.md` | 设计流水线时 |
| 存储器建模 | `references/memory-templates.md` | 例化 BRAM/寄存器堆时 |
| 异步复位同步释放 | `references/reset-templates.md` | 必须用异步复位时 |
| Testbench 结构模板 | `references/tb-templates.md` | 写测试平台时 |
| 注释规范 | `references/comment-standards.md` | 代码审查/清理时 |
| 除法器/LUT 技巧 | `references/division-lut.md` | 非 2ⁿ 除法时 |
| RTL 审查清单 | `references/rtl-code-review.md` | 提交前审查时 |
| 代码简化规范 | `references/simplification-guide.md` | 重构/简化代码时 |

## 关联 Skill
- [code-review](../code-review/SKILL.md) — 代码审查
- [debugging](../debugging/SKILL.md) — 仿真调试
