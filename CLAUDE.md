# Claude Code 配置 v4.0

## 核心规则（L0，必须读）
四条铁律 + Lint First + 验证闭环 → `rules/00-core.md`

## 能力索引

| Skill | 场景 |
|-------|------|
| `/project-init` | FPGA 项目/模块脚手架 |
| `/hdl-coding` | RTL 编写、Testbench |
| `/rag-skill` | 知识库检索 |
| `/tdd` | 测试驱动开发 |
| `/python-hardware-debug` | 星座图/EVM/频偏分析 |
| `/code-review` | 代码审查 |

| MCP | 触发条件 |
|:----|:---------|
| matlab | .m 文件、golden model、定点化 |
| mcp-pdf | PDF 文档操作 |

## 工作流触发
用户关键词 → 对应工作流。详细见 `rules/05-workflow-trigger.md`。

## 参考
- `knowledge/references/reference-index.md` — 完整索引
- `knowledge/INDEX.md` — 知识库（优先使用 rag-skill 检索）

## 版本
v4.0 (2026-06-09): 目录重构 — rules/ + engine/ + knowledge/ + var/
