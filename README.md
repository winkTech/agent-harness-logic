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
├── docs/rules/            ← L1 边界：约束规则（渐进式披露，由 rule-loader 按需注入）
│   ├── 00-core.md         ←     核心路由 + 常驻指引
│   ├── 01-hdl.md          ←     HDL 编码规范（五条红线 + Vivado 证据要求）
│   ├── 02-python.md       ←     Python 开发规范
│   ├── 03-gates.md        ←     需求门禁 + 验证质量门禁
│   ├── 04-git.md          ←     Git 操作规则
│   ├── 05-harness.md      ←     记忆/Dream/Hook/维护/规则晋升边界
│   └── README.md          ←     为什么规则不放在 .claude/rules/（避免全文常驻注入）
├── docs/rules-archive/    ← 已归档规则（11 份：调试/安全/认知/系统/约束/检索/绘图/TDD…）
│                                不再加载，仅供追溯
│
├── engine/                ← 核心引擎
│   ├── sqlite/            ←     持久层（FTS5 全文检索 + 记忆/事件/技能/成本）
│   │   └── README.md      ←     SQLite 文档
│   ├── dag-engine.cjs     ←     DAG 调度引擎（拓扑排序 + 分层并行 + 重试/超时）
│   ├── diagnostics.cjs    ←     全系统健康诊断
│   ├── hooks/
│   │   ├── learning/
│   │   │   ├── postflight-observer.cjs ← 异步纠正/生命周期信号观察器
│   │   │   ├── signal-collector.cjs   ← 观察器内部信号适配器（非直接 Hook）
│   │   │   ├── cost-tracker-hook.cjs  ← 每次响应成本估算
│   │   │   └── skill-tracker-hook.cjs ← 技能触发追踪
│   │   └── memory/
│   │       └── memory-sqlite-sync.cjs ← dormant 兼容脚本（当前未注册 Hook）
│   ├── scripts/
│   │   ├── hooks/          ←     本地 Hook 入口与纯函数守卫（热路径由单进程 router 调度）
│   │   │   ├── bash-safety-guard.cjs      ←     Bash 危险命令 / 绕过写入拦截
│   │   │   ├── hdl-gate.cjs               ←     HDL 红线门禁
│   │   │   ├── verification-gate.cjs      ←     验证闭环门禁
│   │   │   ├── requirements-gate-guard.cjs ←    需求门禁守卫
│   │   │   ├── tool-action-contract-gate.cjs ←  工具动作合同门禁
│   │   │   └── agent-transparency-ledger.cjs ←  透明度账本写入
│   │   ├── test-hooks/
│   │   │   ├── run-all-tests.cjs     ←     Hook 全量测试套件（harness-ci.cjs 的主体）
│   │   │   └── test-e2e.cjs          ←     E2E 恢复测试 (6 项)
│   │   ├── lib/
│   │   │   ├── lint-utils.cjs         ←     lint 工具共享库
│   │   │   └── judge-service.cjs      ←     ELO 评分 + 多 Judge 投票
│   │   ├── dream-consolidate.cjs      ← Dream 自学习提炼器
│   │   ├── memory-health-check.cjs    ← 记忆系统健康检查
│   │   ├── memory-knowledge-maintenance.cjs ← 只读规划 + 受控维护
│   │   ├── harness-rule-candidates.cjs ← 候选→验证→批准→规则晋升
│   │   ├── ecc-root-resolver.cjs      ← ECC 插件根路径共享解析
│   │   ├── semantic-search.cjs        ← L2: TF-IDF 语义检索
│   │   ├── memory-retrieve.sh         ← L2: 统一检索入口
│   │   ├── runtime-state.cjs          ← L3: 运行时状态管理器
│   │   ├── agent-context-budget.cjs   ← 上下文预算 + 智能压缩
│   │   ├── harness-ci.cjs             ← fail-closed CI 总门禁（静态/注册表/回归/覆盖率）
│   │   ├── eda-detect.cjs             ← EDA 工具链探测（Vivado/Questa/Verilator…）
│   │   ├── fpga-util-parser.cjs       ← Vivado 资源报告 → JSON
│   │   ├── fpga-timing-parser.cjs     ← Vivado 时序报告 → JSON
│   │   ├── coverage-runner.cjs        ← V8 代码覆盖率检测
│   │   ├── dashboard-html.cjs         ← 静态 HTML 仪表盘生成器
│   │   ├── delivery-tracker.cjs       ← 交付率追踪
│   │   ├── fp-rate-tracker.cjs        ← 门禁假阳性率追踪
│   │   ├── judge-calibration.cjs      ← LLM-as-Judge 校准度评估
│   │   └── quality-regression-dashboard.cjs  ← 质量退化仪表盘
│   └── schemas/           ← JSON Schema 定义
│
├── memory/                ← L2 记忆：活跃记忆
│   ├── learnings/         ←     已验证经验（默认 180 天复核，不永久常驻）
│   ├── errors/            ←     候选错误经验（默认 90 天提炼或退役）
│   ├── projects/          ←     项目级记忆
│   ├── references/        ←     跨项目参考链接
│   └── archive/           ←     已归档历史
│
├── engineering-assets/knowledge/             ← L2 记忆：领域知识库（3414 文件）
│   ├── primary/domains/   ←     核心领域（fpga / comm / matlab / python）
│   ├── docs/              ←     技术文档与模板（含上游导入的模板包）
│   └── archive/sources/   ←     原始资料转写稿（*-source.md，取代已废弃的 source/datasheets/）
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
>
> ⚠️ 但**加粗的才是硬拦截**（`exit 2`）。标「提醒」的走 advisory：输出建议、仍然放行。
> 区别很要紧——把 advisory 当硬拦截会误以为"没被拦就是合规"。哪些是哪些由
> `engine/scripts/test-hooks/gate-registry-contract.cjs` 持续校验，防止本表再次漂移。

### 当前 Hook 拓扑

> **Hook 配置的唯一位置：`settings.json`**（2026-07-27 起）。
> 新增/修改 hook 一律写进 `settings.json` 的 `hooks` 段，**不要**再往 `settings.local.json` 里放
> —— 两处都注册会导致同一个 hook 每次触发跑两遍（迁移前 `verification-gate` 在
> PostToolUse+Bash 上就是这种状态）。
>
> `settings.local.json` 现在只承载 `permissions` / `enabledPlugins` / `env`。
>
> ⚠️ `settings.json` 在 `.gitignore` 里（hook 命令含本机绝对路径），文件本身不入版本库。
> 但**注册内容入库**：权威声明在 `engine/hooks/registrations.json`，用 `{{HARNESS_ROOT}}` 占位。
>
> ```bash
> node engine/scripts/render-hook-settings.cjs          # 换机/新克隆：生成本机 settings.json
> node engine/scripts/render-hook-settings.cjs --check   # 校验本机注册是否与模板漂移
> node engine/scripts/sync-workflow-mirror.cjs           # 同理重建 .claude/workflows/ 镜像
> ```
>
> 改 hook 请改**模板**再渲染；直接改 `settings.json` 会被 `--check` 报漂移。
> CI 在跑门禁前会执行这两步 —— 否则全新 checkout 上一条注册都没有，
> `engine/hooks/manifest.json` 里标 `active` 的条目会全部核对不上。
> 改完请自测一次触发，不要只看 JSON 语法。

下表以 `settings.json` 为唯一事实源；`preflight-router.cjs` 在一个进程内加载匹配门禁，README 不复制易漂移的内部清单。

| 事件 | 时机 | 当前执行路径 |
|:-----|:-----|:-------------|
| `UserPromptSubmit` | 每条用户消息 | prompt-context.cjs：同进程合并规则 capsule、只读事实查询；实际注入另记 exposure |
| `PreToolUse` | 每次工具调用前 | preflight-router.cjs（进程内路由） |
| `PostToolUse` | 工具成功后 | postflight-router.cjs（同步状态/可信验证结果）+ postflight-observer.cjs（异步遥测/弱归因观察） |
| `PostToolUseFailure` | 工具失败后 | postflight-router.cjs（同步状态与失败记忆）+ postflight-observer.cjs（异步失败遥测/弱归因观察） |
| `SessionStart` | startup/resume/clear/compact/fork | session-bootstrap.cjs（单进程恢复/Dream/isolation）+ 到期维护（async，仅 startup） |
| `PreCompact` | 上下文压缩前 | pre-compact.cjs 保存可恢复状态 |
| `Stop` | 响应结束 | stop-summary.cjs（同步上下文/进度）+ postflight-observer.cjs（异步透明度/成本/Skill-Evolve） |

活跃入口的事件、工具、载荷契约、阻塞性、副作用、超时、负责人和行为夹具统一声明在 `engine/hooks/manifest.json`；`harness-ci.cjs` 会拒绝未声明入口、事件错接线和缺失依赖。

### 安全拦截（settings.local.json deny）

| 操作 | 拦截 |
|:-----|:-----|
| `git push --force` / `git reset --hard` / `git clean -fd` | ❌ 拒绝 |
| `git push origin main/master` / `git push --delete` | ❌ 拒绝 |
| `git commit --amend` / `git branch -D` | ❌ 拒绝 |
| `rm -rf /` / `rm -rf ~` | ❌ 拒绝 |

---

## L2 记忆层：分层事实、时效检索与受控晋升

### SQLite 持久层（`engine/sqlite/`）

零外部依赖（Node ≥22 `node:sqlite`），WAL 模式，FTS5 全文检索：

| Store | 职责 | 证据边界 |
|:------|:-----|:---------|
| `store-memory.cjs` | 候选/已验证事实与 FTS5 检索 | 先按 project/path/trigger 硬过滤；默认只返回未过期 verified |
| `store-memory-attribution.cjs` | exposure/application/outcome 归因链 | 命中不是应用，后续动作不是因果；只有 Verification Gate 可写 outcome |
| `store-events.cjs` | Dream、Hook 与维护的运行时输入、消费者心跳 | 事件是遥测；watermark 与 heartbeat 只由真实有界执行推进 |
| `store-skills.cjs` | 技能触发与效果统计 | 统计相关性不能替代行为验证 |
| `store-costs.cjs` | 每 session 的成本记账 | 仅用于观测，不进入默认记忆召回 |

### 分层与晋升

```
运行遥测 → 候选经验 → 行为验证 → 显式批准 → 仓库 Harness 规则
```

- `tool_success`、单次错误和 Hook 回显不属于长期记忆；
- 错误经验只有同时具备根因、已验证修复、预防动作和触发条件，才进入候选账本；
- Harness 规则的唯一生命周期是 `candidate -> verified -> approved -> promoted`；
- Dream 只能产生 candidate；verified 必须来自 Verification Gate 账本中同一行为契约的真实 RED/GREEN，且必须有用户显式 approval 才能进入规则；
- promoted 文件在加载和执行前复核 candidate id、批准记录与 artifact SHA-256；缺账本、手工复制或被篡改的文件不生效并进入健康告警；
- 详细 TTL、退役与召回条件见 `memory/MEMORY_RULES.md`，稳定约束见 `docs/rules/05-harness.md`。

### 统一检索链

```
稳定 project id → project/path/trigger 硬过滤 → verified/valid_until 门禁 → FTS5 / semantic 排名 → 注入 1–3 条
                                                                                              ↓
             exposure → observed follow-up / rule-enforced application → Verification Gate outcome
```

缺少作用域时只允许 `global_harness`，不会回退到跨仓库扫描；candidate/needs-reverify 只能通过显式 review 查询读取，不进入默认上下文。语义索引的 eligible 文件、mtime、meta 或 builtAt 不一致时，查询返回 `stale_index` 和空结果，必须显式重建后再使用。详见 `docs/rules-archive/09-search-tools.md`。

归因链使用完整的 retrieval/session/project/memory/correlation identity。`exposure` 只证明 Agent 看到了摘要；普通后续工具调用只记 weak observed follow-up，`rule-enforced` 才是 strong application；即使验证通过也保持 `causal_claim=unproven`，不得把相关性写成“记忆导致成功”。

### 健康与维护

```powershell
node engine/scripts/memory-health-check.cjs --json
node engine/scripts/memory-knowledge-maintenance.cjs --dry-run --json
node engine/scripts/kb-stats.cjs --check --quiet --json
```

`memory-health-check` 以 `engine/hooks/manifest.json` 的 consumer registry 为事实源，核对真实路由、最近 heartbeat、失败/陈旧状态、backlog/watermark、verified fact 的 scope/trigger/evidence/validity、exposure/application/outcome 身份链，以及 candidate 状态与 30/90 天审查期限。没有 outcome 不自动判错；孤儿归因链、逾期候选或不完整候选才进入问题列表。`dry-run` 不写 SQLite、候选账本、索引或维护状态；execute 只通过受控的事件保留、权威文件事实对账、候选 staging、索引重建和状态接口执行。文件数量下降不是健康证据。

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

**挫败检测**: `frustration-detector` hook 监听中英 20+ 模式，≥3 次失败自动建议切换模式。推理模式定义见已归档的 `docs/rules-archive/06-cognition.md`。

---

## L5 技能层

13 核心技能（slash 命令）+ 17 Agent 角色 + 6 工作流。完整列表见 `engineering-assets/knowledge/references/skills-catalog.md`。

**DAG 工作流**（`hdl-coding-dag-workflow.js`）：10 阶段 HDL 开发流程 v3.4，Phase 2(定点)+Phase 3(TB) 并行、Phase 6(回归)+Phase 7(审查) 并行，含证据门禁 + Verifier 终验节点。

---

## 🔄 受控学习闭环（Dream v2.0）

```
信号采集(6+类型) → SQLite events → dream-consolidate v2 → 
  跨类型模式检测 → candidate → 行为验证 → 显式批准 → promoted rule
```

**采集升级 v2.0**: 6 种新信号类型 — `rule_load`, `context_pressure`, `mode_switch`, `memory_cross_ref`, `session_handoff`, `loop_skip`
**检测边界**: 跨类型序列、错误聚类和时间模式只提供候选线索；Dream 相关性不是根因证据。
**晋升边界**: Dream 只产生候选 candidate；没有行为测试 PASS 与用户显式批准 approval，不得写入耐久 Harness 规则。
**消费边界**: 每个事件消费者使用独立 watermark；Dream 与 Skill-Evolve 都必须有有界调度；任何 dry-run 都不得推进消费进度。注册消费者未调度或落后时，健康检查失败且 retention 按所有注册消费者的最小水位保持阻塞，不允许筛掉或强推。

详见 `engine/scripts/dream-consolidate.cjs`（检测引擎）、`engine/scripts/harness-rule-candidates.cjs`（晋升账本）和 `docs/rules/05-harness.md`（稳定规则）。

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
node engine/scripts/memory-health-check.cjs --json

# 维护计划只读预览；显式执行前先审查 JSON
node engine/scripts/memory-knowledge-maintenance.cjs --dry-run --json

# 知识与语义索引 freshness（失败时 quiet 仍非零退出）
node engine/scripts/kb-stats.cjs --check --quiet --json

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
| 核心规则 | `docs/rules/00-core.md` |
| Git 操作规则 | `docs/rules/04-git.md` |
| Harness/记忆规则 | `docs/rules/05-harness.md` |
| 记忆时效与退役 | `memory/MEMORY_RULES.md` |
| 安全规则 | `docs/rules-archive/04-security.md` |
| 认知层 | `docs/rules-archive/06-cognition.md` |
| 检索工具选择 | `docs/rules-archive/09-search-tools.md` |
| 绘图规则 | `docs/rules-archive/10-drawing.md` |
| TDD 测试驱动 | `docs/rules-archive/12-tdd.md` |
| 查技能列表 | `engineering-assets/knowledge/references/skills-catalog.md` |
| 查完整索引 | `engineering-assets/knowledge/references/reference-index.md` |
| SQLite 文档 | `engine/sqlite/README.md` |
| 系统诊断 | `node engine/diagnostics.cjs` |
| 记忆健康 | `node engine/scripts/memory-health-check.cjs` |
| 记忆维护预览 | `node engine/scripts/memory-knowledge-maintenance.cjs --dry-run --json` |
| 规则候选账本 | `node engine/scripts/harness-rule-candidates.cjs list` |
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
