# Claude Code Harness

你的 Claude Code 治理基础设施。基于五层架构（边界/记忆/交接/认知/技能），将 Claude 从"能写代码的助手"变成"能守规矩的同事"。

> **核心哲学**: 可靠的系统承载不可靠的模型。让脚本做验证，让文件做证据，让 hook 做拦截——不让模型自报数据。

---

> 🚀 **首次使用?** 先看 [快速入门.md](快速入门.md) — 5 分钟上手 + 架构图解 + 常见任务速查。

---

## 目录结构

```
~/.claude/
│
├── CLAUDE.md              ← 核心指令（session 注入）
├── rules/                 ← L1 边界：约束规则（渐进式披露）
│   ├── 00-core.md         ←     四条铁律 + Lint First + 验证闭环
│   ├── 01-hdl.md          ←     HDL 编码规范
│   ├── 02-python.md       ←     Python 开发规范
│   ├── 03-debugging.md    ←     调试方法论
│   ├── 04-security.md     ←     安全准则（禁止/需确认操作）
│   ├── 05-workflow-trigger.md  ← 关键词→工作流映射
│   ├── 06-cognition.md    ← L4: 7 种推理模式定义
│   ├── 07-system.md       ←     系统操作约束（D 盘安装等）
│   ├── 08-constraints.md  ←     硬约束（保护 golden model 等）
│   ├── 09-search-tools.md ← L2: 检索工具选择矩阵
│   ├── 10-drawing.md      ←     绘图规则
│   ├── 11-git.md          ←     Git 操作规则
│   └── 12-tdd.md          ←     TDD 测试驱动开发规则
│
├── engine/                ← 核心引擎
│   ├── sqlite/            ←     持久层（FTS5 全文检索 + 记忆/事件/技能/成本）
│   │   └── README.md      ←     SQLite 文档
│   ├── dag-engine.cjs     ←     DAG 调度引擎（拓扑排序 + 分层并行 + 重试/超时）
│   ├── diagnostics.cjs    ←     全系统健康诊断
│   ├── hooks/
│   │   ├── learning/
│   │   │   ├── signal-collector.cjs   ← 运行时信号采集（Dream 输入源）
│   │   │   ├── cost-tracker-hook.cjs  ← 每次响应成本估算
│   │   │   └── skill-tracker-hook.cjs ← 技能触发追踪
│   │   └── memory/
│   │       └── memory-sqlite-sync.cjs ← 记忆文件 ↔ SQLite 同步
│   ├── scripts/
│   │   ├── hooks/          ←     本地 hook 脚本（lint/diff/挫败检测/文件保护）
│   │   │   ├── python-gate.cjs        ←     Python 专用门禁 (TDD + 安全)
│   │   │   ├── matlab-gate.cjs        ←     MATLAB 专用门禁 (golden 保护)
│   │   │   ├── coverage-gate.cjs      ←     覆盖率退化门禁
│   │   │   └── fpr-calibration-hook.cjs  ← 自动假阳性校准
│   │   ├── test-hooks/
│   │   │   ├── run-all-tests.cjs     ←     115 条 Hook 测试套件
│   │   │   └── test-e2e.cjs          ←     E2E 恢复测试 (6 项)
│   │   ├── lib/
│   │   │   ├── lint-utils.cjs         ←     lint 工具共享库
│   │   │   └── judge-service.cjs      ←     ELO 评分 + 多 Judge 投票
│   │   ├── dream-consolidate.cjs      ← Dream 自学习提炼器
│   │   ├── memory-health-check.cjs    ← 记忆系统健康检查
│   │   ├── ecc-root-resolver.cjs      ← ECC 插件根路径共享解析
│   │   ├── semantic-search.cjs        ← L2: TF-IDF 语义检索
│   │   ├── memory-retrieve.sh         ← L2: 统一检索入口
│   │   ├── runtime-state.cjs          ← L3: 运行时状态管理器
│   │   ├── agent-context-budget.cjs   ← 上下文预算 + 智能压缩
│   │   ├── agent-context-watchdog.cjs ← Agent 上下文监测
│   │   ├── coverage-runner.cjs        ← V8 代码覆盖率检测
│   │   ├── dashboard-html.cjs         ← 静态 HTML 仪表盘生成器
│   │   ├── delivery-tracker.cjs       ← 交付率追踪
│   │   ├── fp-rate-tracker.cjs        ← 门禁假阳性率追踪
│   │   ├── judge-calibration.cjs      ← LLM-as-Judge 校准度评估
│   │   └── quality-regression-dashboard.cjs  ← 质量退化仪表盘
│   └── schemas/           ← JSON Schema 定义
│
├── memory/                ← L2 记忆：活跃记忆
│   ├── learnings/         ←     永久经验教训
│   ├── errors/            ←     错误记录（90 天寿命）
│   ├── projects/          ←     项目级记忆
│   ├── references/        ←     跨项目参考链接
│   └── archive/           ←     已归档历史
│
├── engineering-assets/knowledge/             ← L2 记忆：领域知识库（3414 文件）
│   ├── primary/domains/   ←     核心领域（fpga / comm / matlab / python）
│   ├── docs/              ←     技术文档与模板
│   ├── source/            ←     原始资料 PDF（本地引用，不入 git）
│   └── archive/           ←     归档笔记
│
├── skills/                ← L5 技能
│   ├── hdl-coding/ / tdd/ / debugging/ / code-review/ 等核心技能
│   ├── workflows/         ←     多 Agent 工作流（含 DAG 版 HDL 流程）
│   └── agents/            ←     Agent 角色定义
│
├── var/                   ← L3 交接：运行时状态（gitignored，可清理）
│   ├── active-task.yaml   ←     任务协议
│   ├── index/             ←     语义索引 + 代码图谱
│   ├── plugins/           ←     插件缓存
│   └── sessions/ / work/ / plans/
│
├── settings.local.json    ← Hook 注册 + 权限配置 + 插件开关
├── .mcp.json              ← MCP 服务器配置
└── .wright/               ← SQLite 数据库（memory.db，gitignored）
```

---

## L1 边界层：Hook 门禁系统

> CLAUDE.md 写承诺，hooks 写执行。承诺可以被合理化，执行不可以。

### 9 种 Hook 事件 · 42 条注册 Hook

| 事件 | 时机 | 本地钩子 | ECC 插件钩子 |
|:-----|:-----|:---------|:-------------|
| `SessionStart` | 新 session 开局 | memory-track, resolve-plugin-path | session-start-bootstrap |
| `PreToolUse` | 工具调用前 | 挫败检测, pre-commit-lint, diff-size-gate, file-protection-guard, **resource-budget-gate**, **python-gate**, **matlab-gate**, **coverage-gate** | run-with-flags(6 个场景) |
| `PostToolUse` | 工具调用后 | memory-sqlite-sync, skill-tracker | 观测/指标/监控/质量门 |
| `PostToolUseFailure` | 工具失败 | signal-collector(tool_fail) | MCP 健康检查 |
| `Stop` | 响应结束 | lint-auto-gate, cost-tracker | 格式化/检查/Session 持久化 |
| `PostMessage` | 用户消息 | memory-track, signal-collector(drift_stuck) | — |
| `PreCompact` | 压缩前 | — | 状态保存 |
| `PostStop` | 停止后 | — | 异步清理 |
| `SessionEnd` | 对话结束 | — | 生命周期标记 |

### 安全拦截（settings.local.json deny）

| 操作 | 拦截 |
|:-----|:-----|
| `git push --force` / `git reset --hard` / `git clean -fd` | ❌ 拒绝 |
| `git push origin main/master` / `git push --delete` | ❌ 拒绝 |
| `git commit --amend` / `git branch -D` | ❌ 拒绝 |
| `rm -rf /` / `rm -rf ~` | ❌ 拒绝 |

---

## L2 记忆层：SQLite FTS5 + 四工具检索

### SQLite 持久层（`engine/sqlite/`）

零外部依赖（Node ≥22 `node:sqlite`），WAL 模式，FTS5 全文检索：

| Store | 职责 | 当前规模 |
|:------|:-----|:---------|
| `store-memory.cjs` | 事实存储（40 条，FTS5 BM25 排序，LIKE 降级） | 7 命名空间 |
| `store-events.cjs` | 运行时事件（Dream 自学习输入源） | 6 种事件类型 |
| `store-skills.cjs` | 技能注册表（触发/成功率/自动退役） | 12 技能 |
| `store-costs.cjs` | 成本记账（每 session token 估算） | 每次 Stop 自动写入 |

### 统一检索链

```
SQLite FTS5 (BM25 排序) → Grep/Glob → git log → rag-skill/code-search → 完整 Read
```

详见 `rules/09-search-tools.md`。

---

## L3 交接层

| /start（开局） | /handoff（收尾） |
|:--------------|:----------------|
| 读 active-task.yaml | 写 active-task.yaml |
| 读 git log + status | 写 session 日志到 var/work/ |
| 健康预检（memory-health + Dream dry-run） | flush runtime-state |
| 输出 Briefing（≤35 行） | 输出 Handoff Report（≤15 行） |

---

## L4 认知层：7 种推理模式

| 模式 | 场景 | 方法 |
|:-----|:-----|:-----|
| 根因分析 | 修 bug、查事故 | 5-Why + 同类模式扫描 |
| 第一性原理 | 新建功能、设计方案 | 质疑→删除→简化→加速→自动化 |
| 减法 | 重构、清理 | 删除优先，不增新抽象 |
| 搜索优先 | 根因未知、领域不熟 | 先查后判，不猜测 |
| 倒推 | 新模块设计 | 从用户终态倒推接口 |
| 证据驱动 | 性能优化、方案选型 | 基准→修改→测量→结论 |
| 闭环 | 默认模式 | 定目标→追过程→拿结果 |

**挫败检测**: `frustration-detector` hook 监听中英 20+ 模式，≥3 次失败自动建议切换模式。详见 `rules/06-cognition.md`。

---

## L5 技能层

13 核心技能（slash 命令）+ 17 Agent 角色 + 6 工作流。完整列表见 `engineering-assets/knowledge/references/skills-catalog.md`。

**DAG 工作流**（`hdl-coding-dag-workflow.js`）：10 阶段 HDL 开发流程 v3.4，Phase 2(定点)+Phase 3(TB) 并行、Phase 6(回归)+Phase 7(审查) 并行，含证据门禁 + Verifier 终验节点。

---

## 🔄 自学习飞轮（Dream v2.0）

```
信号采集(6+类型) → SQLite events → dream-consolidate v2 → 
  跨类型模式检测 → learnings 事实写入 → 置信度升级(时间衰减) → 技能退役
  ↓
SessionStart: dream-startup-inject → 自动检索 + 上下文注入
```

**采集升级 v2.0**: 6 种新信号类型 — `rule_load`, `context_pressure`, `mode_switch`, `memory_cross_ref`, `session_handoff`, `loop_skip`
**检测升级 v2.0**: 跨类型事件序列、代码错误聚类、时间序列模式
**调度升级**: 每次 SessionStart 自动检查未处理事件数 ≥10 → 运行 `dream-consolidate --dry-run` → 注入近期 Learnings 到上下文

详见 `engine/scripts/dream-consolidate.cjs`（检测引擎）和 `engine/scripts/dream-startup-inject.cjs`（调度注入）。

---

## 📊 系统诊断

```bash
# 全量健康检查（含 FPGA 环境）
node engine/diagnostics.cjs

# Hook 延迟基准 + SLA 检查
node engine/diagnostics.cjs --bench

# 快速检查（仅 PreToolUse 延迟）
node engine/diagnostics.cjs --quick

# Hook 集成测试（37 条 hook dry-run）
node engine/diagnostics.cjs --hooks

# 记忆系统专项
node engine/scripts/memory-health-check.cjs

# Dream 试运行
node engine/scripts/dream-consolidate.cjs --dry-run

# 模板元数据检查
node engine/diagnostics.cjs --templates

# Dream 自学习飞轮
## 采集 → 检测 → 注入 全链路
node engine/scripts/dream-consolidate.cjs                 # 全量运行
node engine/scripts/dream-consolidate.cjs --dry-run        # 试运行(不写文件)
node engine/scripts/dream-startup-inject.cjs               # 模拟 SessionStart 注入

# EDA 工具链检测
## 自动检测 vlog / xvlog / verilator / iverilog / Vivado
## Windows 上自动解析 .bat 包装器，Vivado 通过目录扫描回退
node engine/scripts/eda-detect.cjs
node engine/scripts/eda-detect.cjs --json

# FPGA 约束/时序/资源/波形工具
node engine/scripts/fpga-xdc-parser.cjs <file.xdc>
node engine/scripts/fpga-timing-parser.cjs <timing.rpt>
node engine/scripts/fpga-util-parser.cjs <util.rpt>
node engine/scripts/fpga-wave-helper.cjs detect

# 新项目脚手架
node engine/scripts/harness-init.cjs
```

---

## 📐 评估基础设施（Benchmarking & Observability）

Harness 配备 7 个评估工具，覆盖质量度量、交付追踪、Judge 校准和端到端验证。

```
质量退化 ─→ quality-regression-dashboard.cjs  ← 跨 session 指标趋势
交付率   ─→ delivery-tracker.cjs              ← DAG 阶段完成率/重试率
假阳性率 ─→ fp-rate-tracker.cjs               ← 门禁拦截准确率 (auto-record)
代码覆盖 ─→ coverage-runner.cjs               ← V8 行覆盖率 (阈值 60%)
HTML 仪表 ─→ dashboard-html.cjs               ← 自包含 Chart.js 仪表盘
Judge 校准─→ judge-calibration.cjs            ← 6 样本 100% + ELO 评分
E2E 验证   ─→ test-hooks/test-e2e.cjs          ← 6 项集成测试
```

### 一键套件

```bash
# 全量测试 (115 条)
node engine/scripts/test-hooks/run-all-tests.cjs

# 覆盖率 (目标 ≥60%)
node engine/scripts/coverage-runner.cjs

# E2E 恢复测试
node engine/scripts/test-hooks/test-e2e.cjs

# 生成实时仪表盘 (自动弹出浏览器)
node engine/scripts/dashboard-html.cjs generate
```

### 交付率追踪 (DAG 工作流)

```bash
node engine/scripts/delivery-tracker.cjs record --phase=P4 --status=pass --modules=3
node engine/scripts/delivery-tracker.cjs report   # 柱状图按阶段
```

### 门禁假阳性/假阴性率

```bash
node engine/scripts/fp-rate-tracker.cjs record --gate=verification --correct=true
node engine/scripts/fp-rate-tracker.cjs auto-record  # 从 SQLite 自动推断
node engine/scripts/fp-rate-tracker.cjs report        # 按 gate 分层报告
```

### ELO Judge 校准

```bash
node engine/scripts/judge-calibration.cjs init       # 创建 6 个基准样本
node engine/scripts/judge-calibration.cjs run         # 运行校准 (默认规则)
node engine/scripts/judge-calibration.cjs run --judges=3  # 多 Judge 投票
node engine/scripts/judge-calibration.cjs run --elo       # 含 ELO 评分
node engine/scripts/judge-calibration.cjs elo             # 查看 ELO 排行
```

### 质量退化检测

```bash
node engine/scripts/quality-regression-dashboard.cjs record --metric=fmax --value=250
node engine/scripts/quality-regression-dashboard.cjs trend --metric=coverage --days=30
node engine/scripts/quality-regression-dashboard.cjs report  # 自动 10% 退化警报
```

所有工具遵循统一的 `report --json` 接口，数据直接由 HTML 仪表盘读取。

---

## MCP 服务器

| MCP | 配置来源 | 用途 |
|:----|:---------|:-----|
| `mcp-pdf` | `.mcp.json`（npx mcp-pdf） | 读取/编辑/合并/签名 PDF |
| `matlab` | 本地二进制 `engine/mcp/` | MATLAB 代码分析 |

---

## 设计原则

### 1. Context Engineering
> 提示工程优化"模型看到什么"，上下文工程优化"什么时刻让模型看到什么、什么不让它看到"。

- **L1 hooks**: 工具调用前后注入/拦截
- **L2 记忆**: 从历史召回什么进 context
- **L3 交接**: 上 session 的什么信息带到下 session
- **L4 认知**: 失败信号注入新框架
- **L5 技能**: 任务信息接触顺序

### 2. 不代打
四工具场景 clear-cut → Claude 自己学选。Hook 拒绝是物理拦截 → Claude 看不到逻辑，无法绕过。

### 3. 脱敏
所有 git 跟踪文件不包含用户主目录路径。使用 `os.homedir()` 动态解算。

---

## 快速入口

| 你要做的事 | 入口 |
|-----------|------|
| 核心规则 | `rules/00-core.md` |
| 安全规则 | `rules/04-security.md` |
| 认知层 | `rules/06-cognition.md` |
| 检索工具选择 | `rules/09-search-tools.md` |
| 绘图规则 | `rules/10-drawing.md` |
| Git 操作规则 | `rules/11-git.md` |
| TDD 测试驱动 | `rules/12-tdd.md` |
| 查技能列表 | `engineering-assets/knowledge/references/skills-catalog.md` |
| 查完整索引 | `engineering-assets/knowledge/references/reference-index.md` |
| SQLite 文档 | `engine/sqlite/README.md` |
| 系统诊断 | `node engine/diagnostics.cjs` |
| 记忆健康 | `node engine/scripts/memory-health-check.cjs` |
| 看当前任务 | `/start` 或 `cat var/active-task.yaml` |
| 起始/收尾 | `/start` 或 `/handoff` |
| 清理运行时 | `rm -rf var/*`（不影响代码） |
| Hook 测试套件 | `node engine/scripts/test-hooks/run-all-tests.cjs` |
| E2E 恢复测试 | `node engine/scripts/test-hooks/test-e2e.cjs` |
| 代码覆盖率 | `node engine/scripts/coverage-runner.cjs` |
| HTML 仪表盘 | `node engine/scripts/dashboard-html.cjs generate` |
| Judge 校准 | `node engine/scripts/judge-calibration.cjs run` |
| 门禁假阳性率 | `node engine/scripts/fp-rate-tracker.cjs report` |
| 交付率追踪 | `node engine/scripts/delivery-tracker.cjs report` |
