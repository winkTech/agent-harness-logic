# Claude Code 配置 v3.2

## 一、通用编码准则

**四条铁律**：
1. **编码前思考** — 明确假设，不确定就提问，有更简单方案就说
2. **简单优先** — 最小代码解决问题，不添加未要求的功能
3. **精准修改** — 只触及必须部分，匹配现有风格
4. **目标驱动** — 定义成功标准，循环直到验证通过

## 二、执行规则

### 语言
- 所有输出使用中文（特殊字符/信号除外）

### Lint First（写完代码必须检查）
所有代码提交前必须通过语法检查。Verilog/SV: `vlog -lint <file>`，Python: `ruff check`，MATLAB: 使用 MCP `check_matlab_code`。仅改 Markdown/注释/README 时免检。

## 三、核心规则

### 新项目 / 新模块启动
- 用户表示"新建项目/工程" → 调用 `/project-init` 技能（自动执行 `scripts/init-project.sh`）
- 用户表示"添加模块" → 调用 `/project-init` 技能的 module 子流程（自动执行 `scripts/init-module.sh`）
- 详细规范见 `knowledge/primary/cross-project-experience.md`

### 建项目后要点
1. 先 git init + 首提交"init: 项目名"
2. 新建模块立刻写 TB，遵循 Testbench-First
3. 每加一个模块，同步更新仿真目录和文档

## 四、核心 Skill 与 MCP

| Skill | 位置 | 场景 |
|-------|------|------|
| 项目初始化 | `project-init/SKILL.md` | FPGA 项目/模块脚手架 |
| HDL编码 | `hdl-coding/SKILL.md` | RTL 编写、Testbench |
| TDD工作流 | `tdd/references/tdd-workflow-local.md` | 测试驱动开发 |
| PDF读取 | `rag-skill/references/pdf_reading.md` | 文档分析 |
| Python调试 | `python-hardware-debug/SKILL.md` | 星座图/EVM/频偏/采数 |

| MCP | 传输 | 触发条件 |
|:----|:---:|:---------|
| matlab | stdio | .m 文件执行、golden model 验证、BER/SNR 仿真、定点化分析 |
| mcp-pdf | stdio | PDF 文档操作 |

## 五、参考资料

`references/reference-index.md` — 完整索引（记忆系统/Agent 机制/错误恢复/插件管理/会话管理/高级功能/版本管理/工具脚本/性能基准）

知识库：`knowledge/INDEX.md`，优先使用 rag-skill 检索。

## 六、版本

v3.2 (2026-06-06): 新增 §3 项目初始化触发规则 + /project-init 技能绑定 + cross-project 瘦身
