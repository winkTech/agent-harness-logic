---
title: "跨项目经验复用"
domain: fpga
tags: [cross-project, experience, reuse, templates]
created: 2026-06-01
updated: 2026-06-06
difficulty: intermediate
---

# 跨项目经验复用

> **更新说明 (2026-06-06)**: 从 1018 行缩减至 ~180 行，移除冗余代码模板
> （代码模板统一存放在 `docs/templates/`）。详见经验教训: [[doc-bloat-anti-pattern]]

---

## 零、快速启动

```bash
# 新项目启动 (在项目根目录执行)
bash path/to/init-project.sh <项目名>

# 添加新模块
bash path/to/init-module.sh <模块名>
```

> 脚本位置: `.claude/scripts/init-project.sh` 和 `init-module.sh`
> 详见: [[../scripts/init-project.sh]], [[../scripts/init-module.sh]]

---

## 一、项目目录结构 (FPGA 项目)

```
prj/
├── 00_comm/           # 全局脚本、配置文件 (JSON等)
├── 01_src/            # 源代码
│   ├── 00_hdl/        # HDL 代码 (按模块分目录)
│   │   ├── 00_com/    # 全局通用模块、头文件
│   │   └── <module>/  # 每个模块一个目录 (小写+下划线)
│   └── 01_ip/         # IP 核 (按功能分: clk/mem/dsp/comm)
├── 02_sim/            # 仿真 (与 01_src/00_hdl/ 下模块同名)
├── 03_xdc/            # 约束文件
├── 04_prj/            # Vivado 工程文件
├── 05_bin/            # 比特流 + 版本说明
├── 06_doc/            # 设计文档
├── 07_mat/            # MATLAB golden model
│   ├── 00_fx/         # 函数
│   ├── 01_conf/       # 配置常量
│   └── 02_script/     # 主模型 + 测试向量生成
├── 08_py/             # Python (仿真/绘图/调试)
├── README.md
└── .claude/           # Claude Code 配置
```

### 命名规则

| 项目 | 规范 | 示例 |
|:-----|:-----|:-----|
| 顶层目录 | 编号 00-09 + 小写字母 | `00_comm`, `01_src/00_hdl` |
| 模块目录 | 功能名 (小写+下划线) | `fifo`, `uart_ctrl`, `ldpc_enc` |
| 仿真目录 | 与模块目录同名 | `02_sim/fifo/` |
| 测试平台 | `tb_<module>.v` | `tb_fifo.v` |
| 测试用例 | `tc_<module>_<test>.v` | `tc_fifo_basic.v` |
| 约束文件 | `top.xdc` 按模块/功能 | `top.xdc`, `ddr.xdc` |

### 核心原则

1. **测试与源文件一一对应**: `02_sim/<module>/tb_<module>.v` 测试 `01_src/00_hdl/<module>/`
2. **无明确指令不改目录**: 只有在新模块/新需求时才创建新目录
3. **模块化**: 每个独立功能一个目录，参数化设计
4. **文件分类归位**: 仿真输出、测试文件、文档、脚本必须归入对应目录，不得散放在项目根目录。参见 §九 文件管理纪律

---

## 二、模块模板参考

| 文件 | 位置 | 用途 |
|:-----|:-----|:-----|
| RTL 模板 | `docs/templates/rtl_module_template.v` | Verilog 模块脚手架 |
| TB 模板 | `docs/templates/tb_template.sv` | 基础测试平台 |
| 算法规格书 | `docs/templates/algorithm_spec_template.md` | 算法设计文档 |
| 定点报告 | `docs/templates/fixed_point_report_template.md` | 定点量化分析 |
| 资源评估 | `docs/templates/resource_estimate_template.md` | LUT/FF/BRAM 预算 |
| UVM 环境 | `docs/templates/uvm/` | AXI-Stream UVM 框架 |

---

## 三、模块接入流程

> 新模块加入已有工程时，需同步更新以下位置：

```
  ① 01_src/00_hdl/<module>/      ← RTL 代码
  ② 02_sim/<module>/             ← 测试平台 + 测试用例
  ③ 01_src/01_ip/<category>/     ← IP 核 (如有)
  ④ 03_xdc/                      ← 时序约束 (如有新时钟)
  ⑤ 07_mat/                      ← MATLAB golden model (如有)
  ⑥ 06_doc/                      ← 模块文档
```

---

## 四、IP 核管理

```
01_src/01_ip/
├── 00_clk/        # PLL, MMCM
├── 01_mem/        # BRAM, FIFO
├── 02_dsp/        # 乘法器, CORDIC, FFT
└── 03_comm/       # UART, SPI, JESD
```

每个 IP 配 `README.md`: 版本、配置参数、接口定义、验证结果。

---

## 五、设计模式速查

| 模式 | 适用场景 | 参考文档 |
|:-----|:---------|:---------|
| **流水线** | 高频/高吞吐 | `fpga/fpga-design-guide` |
| **三段式FSM** | 控制逻辑 | `fpga/ai-hardware-coding-spec` |
| **AXI-Stream** | 模块间数据流 | `docs/templates/uvm/axi_stream_if.sv` |
| **CDC (2-flop)** | 单bit跨时钟域 | `fpga/timing-constraints-guide` |
| **Async FIFO** | 多bit跨时钟域 | `docs/templates/` (参考) |
| **握手机制** | 不同速率模块对接 | `fpga/algorithm-implementation` |

---

## 六、新项目启动清单

### 创建时
- [ ] 确认项目名称 + 目标器件
- [ ] 执行 `init-project.sh <name>` 建目录结构
- [ ] 初始化 Git: `git init && git add -A && git commit -m "init"`
- [ ] 编辑 README.md: 项目简述、开发环境版本
- [ ] 配置 `.claude/settings.json`: hooks 和 MCP

### 每加一个新模块
- [ ] 执行 `init-module.sh <module_name>`
- [ ] 写算法规格书 (参考 `docs/templates/algorithm_spec_template.md`)
- [ ] 写 RTL + TB
- [ ] 功能仿真通过
- [ ] 更新 MATLAB golden model 接口
- [ ] 代码审查 (lint + coding standards)

### 流片/发布前
- [ ] 时序收敛
- [ ] 覆盖率达标
- [ ] 文档归档
- [ ] Git tag

---

## 七、经验记录模板

```markdown
# 项目经验: <名称>

## 基本信息
- 周期: YYYY-MM-DD ~ YYYY-MM-DD
- 器件: <型号>
- 工具: Vivado <版本>

## 关键决策
1. <决策> — 原因: <原因>

## 遇到的问题
1. <问题>
   - 原因: <分析>
   - 解决: <方案>
   - 教训: <防复发措施>

## 可复用组件
- <模块>: <功能简述>
```

完成项目经验后归档到 [[cross-project-experience]]，提取 Lessons 到 `learnings/LESSONS.md`。

---

## 九、文件管理纪律

> 所有工作过程中产生的文件必须有条理地分类存放。禁止"先放根目录，之后再整理"的惰性思维。

### 9.1 强制分类规则

| 文件类型 | 目标目录 | 禁止行为 |
|:---------|:---------|:---------|
| 仿真输出（波形、日志、报告） | `sim/<test_name>/` | ❌ 放项目根目录 |
| 测试文件（Testbench、测试向量） | `tb/<module>/` 或 `02_sim/<module>/` | ❌ 与源码混放 |
| 设计文档/规格书/报告 | `docs/`（按 `docs/plans/`、`docs/reports/` 等细分） | ❌ 散放根目录 |
| 脚本/工具 | `scripts/` | ❌ 放 `01_src/` 下 |
| 编译产物（比特流、中间文件） | `build/`、`out/` 或 `05_bin/` | ❌ 提交到 Git |
| MATLAB golden model | `07_mat/`（按 `00_fx/`、`01_conf/`、`02_script/` 细分） | ❌ 与其他源码混放 |
| Python 仿真/绘图/调试 | `08_py/` | ❌ 放 HDL 目录中 |
| 配置文件（JSON、YAML） | `00_comm/` 或项目根目录下 `*.json` | ❌ 深埋在源码目录中 |

### 9.2 操作规范

1. **创建文件前先确认目标目录存在**，不存在则先建目录再创建文件
2. **引用文件使用相对路径**，保持目录结构可移植
3. **`.gitignore` 必须覆盖**：仿真输出、编译产物、日志等生成文件
4. **仿真输出定向**：运行仿真时通过 `cd sim/<test_name>` 或 `-work` 选项将输出写入指定目录
5. **清理义务**：不再需要的仿真输出和临时文件应及时清理，不堆积

### 9.3 违反后果

- 文件散放 → 增加导航成本，降低团队效率
- 仿真输出混入源码 → 误提交风险，Git 仓库膨胀
- 文档与代码分离不清 → 知识丢失，新人难以接手

> **来源**: 用户反馈 [[file-organization-discipline]]

| 需求 | 文档 |
|:-----|:-----|
| 编码规范 | `fpga/fpga-coding-standards` |
| 设计指南 | `fpga/fpga-design-guide` |
| 时序约束 | `fpga/timing-constraints-guide` |
| Vivado 自动化 | `fpga/vivado-automation-guide` |
| MATLAB→RTL 贯通 | 场景 05 (SCENE_CARDS.md) |
| Lint 检查 | CLAUDE.md → Lint First |
| 知识库结构 | `knowledge/INDEX.md` |
