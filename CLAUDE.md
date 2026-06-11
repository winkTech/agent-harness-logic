# Claude Code 配置 v5.0

## 约束（L0，必须读）
- 通用：四条铁律 + Lint First + 验证闭环 → `rules/00-core.md`
- 安全：禁止操作 + 需确认项 → `rules/04-security.md`
- 系统：安装/下载默认 D 盘，不进 C 盘 → `rules/07-system.md`
- 硬约束：Golden Model 保护 + 系统文件保护 → `rules/08-constraints.md`
- 按上下文自动加载：HDL(`01-hdl.md`)、Python(`02-python.md`)、调试(`03-debugging.md`)
- **新用户首次 session**: 提示阅读 `快速入门.md` — 5 分钟上手

## 认知层（L4）
卡住时自动切换 7 种推理模式 → `rules/06-cognition.md`

## 检索（L2）
五检索工具的使用场景和优先级 (含 SQLite FTS5) → `rules/09-search-tools.md`

## 技能

| Skill | 场景 | 触发词 |
|-------|------|--------|
| `/start` | 新 session 开局（读任务协议 + git 状态 → Briefing） | 开始 / 继续上次 / 恢复进度 |
| `/handoff` | session 收尾（保存进度 + 写日志 + 更新任务协议） | 结束 / 收工 / 保存进度 / 今天到这 |
| `/project-init` | FPGA 项目/模块脚手架 | 新建项目 / 添加模块 / 脚手架 |
| `/hdl-coding` | RTL 编写、Testbench | 写RTL / 写TB / 实现模块 |
| `/rtl-gen` | RTL 快速代码生成 | 快速生成 / 代码模板 |
| `/tdd` | 测试驱动开发 | 测试驱动 / 先写测试 |
| `/code-review` | 代码审查 | 审查 / review / 代码质量 |
| `/debugging` | 系统化调试 | 调查 / debug / 为什么会错 / 挂掉 |
| `/rag-skill` | 知识库检索 | 查知识 / 我记得 / 参考文档 |
| `/code-search` | 统一代码搜索 | 搜代码 / 找文件 / 查找定义 |
| `/git-expert` | Git 操作 | git / 提交 / 推送 / 分支 |
| `/python-hardware-debug` | 星座图/EVM/频偏分析 | 星座图 / EVM / 频偏 / 眼图 |
| `/doc-gen` | 文档生成 | 生成文档 / README / 设计文档 |
| 完整列表 | → `knowledge/references/skills-catalog.md` | — |

| MCP | 触发 |
|:----|:-----|
| matlab | .m 文件、golden model、定点化 |
| mcp-pdf | PDF 文档操作 |

## 持久层（新）
```
engine/sqlite/
├── index.cjs          # 统一入口: openDb/closeDb/backupDb
├── schema.cjs         # 迁移管理 (幂等)
├── store-memory.cjs   # 记忆仓库 (FTS5全文检索)
├── store-events.cjs   # 运行事件 (Dream自学习)
├── store-skills.cjs   # 技能注册表 (统计/退役)
└── store-costs.cjs    # 成本记账
```
数据库: `~/.claude/.wright/memory.db` (git 不可见, Node ≥22 内置 node:sqlite)

## 工作流触发
用户关键词 → 对应工作流。详见 `rules/05-workflow-trigger.md`。
新增 DAG 版 HDL 工作流: `hdl-coding-dag-workflow` (定点+TB并行, 含 Verifier)

## FPGA 工具链（新增 v5.1）
```
engine/scripts/
├── eda-detect.cjs          # EDA 工具自动检测（跨平台，含 Vivado 目录扫描回退）
├── fpga-xdc-parser.cjs     # Vivado .xdc 约束文件解析
├── fpga-timing-parser.cjs  # Timing Report 解析 (WNS/TNS/Fmax)
├── fpga-util-parser.cjs    # Utilization Report 解析 (LUT/BRAM/DSP)
├── fpga-wave-helper.cjs    # 波形辅助 (VCD/WLF dump)
└── harness-init.cjs        # FPGA 项目脚手架 (生成 Makefile/约束/模块模板)
```
lint 自动降级: `lint-utils.cjs` 优先使用检测到的工具链，无 `vlog` 则降级 `xvlog/verilator/iverilog`。
Windows 上自动解析 `.bat` 包装器，Vivado 工具链支持目录级回退检测。

## 诊断
```bash
node engine/diagnostics.cjs            # 全量（含 FPGA 环境）
node engine/diagnostics.cjs --bench    # Hook 延迟基准 P50/P95
node engine/diagnostics.cjs --hooks    # 37 条 hook 集成测试
node engine/diagnostics.cjs --templates # 模板元数据检查
```

## 预检 (run-on-start)
- `memory-health-check.cjs` 记忆系统健康评分
- `dream-consolidate.cjs --dry-run` 检查待提炼事件 (新 session 首次提示)

## 参考
- `knowledge/references/reference-index.md` — 完整索引
- `knowledge/references/skills-catalog.md` — 全部技能/工作流目录
- `knowledge/INDEX.md` — 知识库（优先使用 rag-skill 检索）
- `engine/sqlite/README.md` — SQLite 持久层文档

## 版本
v5.1 (2026-06-10): 10/10 全面升级 — EDA 工具链 + FPGA 解析器 + harness-init + 资源门禁 + 37 条 hook 洁净化
v5.2 (2026-06-11): EDA 检测增强 — 跨平台 .bat 解析 + Vivado 目录扫描回退（支持 shebang/Java loader 不可用场景）
