# Claude Code 配置

> 版本: v3.0 | 更新: 2026-06-01 | 用途: 全局配置，定义核心规则

---

## 一、通用编码准则

> 来源: [andrej-karpathy-skills](https://github.com/shareAI-lab/andrej-karpathy-skills)

**四条铁律**：
1. **编码前思考** — 明确假设，不确定就提问，有更简单方案就说
2. **简单优先** — 最小代码解决问题，不添加未要求的功能
3. **精准修改** — 只触及必须部分，匹配现有风格
4. **目标驱动** — 定义成功标准，循环直到验证通过

**五、通用执行规则**

### 5.1 写完代码必须检查（Lint First）
所有代码（Verilog/SystemVerilog/Python/MATLAB），在写完或修改后、提交前，必须运行对应的 lint/语法检查工具：
- **Verilog/SystemVerilog**: `iverilog -g2012 -t null <file>` 或 `vlog -lint <file>`
- **Python**: `ruff check <file>` 或 `flake8 <file>`
- **MATLAB**: 使用 MATLAB MCP 的 `check_matlab_code` 工具

> 例外: 仅修改注释、README、Markdown 文档时不需要 lint。
> 违反此规则的代码不得提交。

---

## 二、环境配置

### 2.1 语言要求
- 所有输出使用中文（特殊字符/信号除外）

### 2.2 版本管理
- 详细规则：`references/version-rules.md`

---

## 三、核心 Skill

| Skill | 位置 | 场景 |
|-------|------|------|
| HDL编码 | `hdl-coding/SKILL.md` | RTL代码编写、Testbench |
| TDD工作流 | `tdd/references/tdd-workflow-local.md` | 测试驱动开发 |
| PDF读取 | `rag-skill/references/pdf_reading.md` | 文档分析 |

---

## 四、辅助 Skill

完整目录：`references/skills-catalog.md`

---

## 五、高级功能

详细配置：`references/advanced-features.md`

---

## 六、记忆系统

详细规则：`references/memory-system.md`

## 七、会话管理

监控与应对：`references/session-management.md`

---

## 八、MCP 服务器

| MCP | 传输 | 用途 | 文档 |
|:----|:---:|:----|:----|
| `matlab` | stdio | MATLAB 脚本执行/仿真/调试 | `references/mcp-matlab-usage.md` |
| `mcp-pdf` | stdio | PDF 文档操作 | — |

**MATLAB MCP 触发条件**: 涉及 `.m` 文件执行、golden model 验证、BER/SNR 仿真、定点化分析、星座图/眼图等关键词时优先使用。

---

## 九、插件管理

详细配置：`references/plugin-management.md`
新插件说明：`references/new-plugins.md`

---

## 十、Agent 机制

核心原理：`references/agent-harness.md`

## 十一、错误恢复

恢复指南：`references/error-recovery.md`
性能基准：`references/performance-baseline.md`
工具脚本：`references/tool-scripts.md`

## 十二、知识库

索引：`knowledge/INDEX.md`
目录结构：`knowledge/data_structure.md`
学习路径：`knowledge/primary/domains/fpga/learning-path.md`

**检索方式**：使用 rag-skill 智能检索（推荐）

## 十三、参考资料索引

`references/reference-index.md`

---

## 版本历史

- v3.0 (2026-06-01): 模块化重构，详细内容移至 references/ 按需加载
- v2.2 (2026-06-01): 添加新插件适配（coding-tutor、compound-engineering）
- v2.1 (2026-05-31): 精简到200行，保持功能完整性
- v2.0 (2026-05-31): 结构重构，添加目录
- v1.0 (2026-05-30): 初始版本
