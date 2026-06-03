# Claude Code 配置 v3.1

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
所有代码提交前必须通过语法检查。Verilog/SV: `iverilog -g2012 -t null <file>`，Python: `ruff check`，MATLAB: 使用 MCP `check_matlab_code`。仅改 Markdown/注释/README 时免检。

## 三、核心 Skill 与 MCP

| Skill | 位置 | 场景 |
|-------|------|------|
| HDL编码 | `hdl-coding/SKILL.md` | RTL 编写、Testbench |
| TDD工作流 | `tdd/references/tdd-workflow-local.md` | 测试驱动开发 |
| PDF读取 | `rag-skill/references/pdf_reading.md` | 文档分析 |
| Python调试 | `python-hardware-debug/SKILL.md` | 星座图/EVM/频偏/采数 |

| MCP | 传输 | 触发条件 |
|:----|:---:|:---------|
| matlab | stdio | .m 文件执行、golden model 验证、BER/SNR 仿真、定点化分析 |
| mcp-pdf | stdio | PDF 文档操作 |

## 四、参考资料

`references/reference-index.md` — 完整索引（记忆系统/Agent 机制/错误恢复/插件管理/会话管理/高级功能/版本管理/工具脚本/性能基准）

知识库：`knowledge/INDEX.md`，优先使用 rag-skill 检索。

## 五、版本

v3.1 (2026-06-03): 精简至 ~60 行，去格式化开销和低价值文件指针
