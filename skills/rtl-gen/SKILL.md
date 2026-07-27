---
name: rtl-gen
description: RTL 模块生成器 — 交互式输入需求，基于 Xilinx 官方手册架构生成生产级 RTL 代码。入口命令 /rtl-gen
version: 1.0.0
---

# RTL Module Generator

## 用户意图触发

| 用户输入 | 含义 |
|:---------|:------|
| `/rtl-gen <module>` | 生成指定 RTL 模块 |
| `/rtl-gen <module> <param>=<val>` | 带预设参数生成 |

## 调度规则

解析 `args` 的第一个 token 为模块名，路由到对应子 Skill：

| 子命令 | 子 Skill | 参考手册 |
|:-------|:---------|:---------|
| `fifo` | `modules/fifo.md` | PG057 FIFO Generator |
| `fir` | `modules/fir.md` | PG149 FIR Compiler |
| `bram` | `modules/bram.md` | PG058 Block Memory Generator |

其余参数（如 `depth=32 width=8`）透传给子模块处理。

## 通用生成流程（所有子 Skill 共享）

每个子 Skill 遵循以下 5 步流程：

### Step 1: 需求收集
- 读取对应 `modules/<module>.md` 中的**参数表**
- 逐个检查参数是否已通过 args 提供
  - **已提供** → 使用该值，确认用户意图
  - **未提供** → 向用户提问，说明默认值
- 要求用户**提供完整设计规格**，不允许"之后再配置"

### Step 2: 参数确认汇总
- 以表格形式汇总所有参数
- 请用户确认无误后进入下一步

### Step 3: 读取手册架构
- 子 Skill 中已嵌入**基于官方手册的关键架构信息**
- 严格按照手册定义的**接口信号**、**时序结构**、**功能特性**生成代码
- 生成前先向用户简要说明选择的架构类型（如"同步 Block RAM FIFO, Standard 模式"）

### Step 4: RTL 代码生成
- 按照 `references/rtl-production-standards.md` 的规范
- 遵循子 Skill 中的**代码模板结构**
- 生成完整的 SystemVerilog 模块（`.sv`）

**代码质量要求：**
- 参数化设计 — 全部使用 `parameter`
- 完整 `localparam` 状态/地址定义
- 输入寄存 + 输出寄存
- 所有 `case` 有 `default`，所有 `if` 有 `else`
- 时序逻辑 `<=`，组合逻辑 `=`
- 位宽匹配，`$clog2` 计算地址位宽
- 跨时钟域信号标注 `_cdc` + 双寄存器同步
- 时序图用注释说明

### Step 5: 生成后验证
1. 运行语法检查: `vlog -lint <file>`（若不可用则 `iverilog -g2012 -t null -s <top> <file>`）
2. 如有报错 → 修复 → 重新 lint 直到通过
3. 询问用户是否要生成 Testbench

### Step 6: 输出
- 在项目 `rtl/` 目录下生成代码文件
- 如未指定路径，以 `<module>_gen.sv` 命名写入当前目录
- 显示生成的代码摘要（端口列表 + 关键参数）

## 参考文档

| 资源 | 路径 |
|:-----|:------|
| 生产级 RTL 规范 | `references/rtl-production-standards.md` |
| FIFO 生成器 | `modules/fifo.md` |
| FIR 生成器 | `modules/fir.md` |
| BRAM 生成器 | `modules/bram.md` |
| HDL 编码规范 | `../hdl-coding/SKILL.md` |
