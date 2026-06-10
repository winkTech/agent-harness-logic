# Claude Code Harness

你的 Claude Code 治理基础设施。基于五层架构（边界/记忆/交接/认知/技能），将 Claude 从"能写代码的助手"变成"能守规矩的同事"。

> **核心哲学**: 可靠的系统承载不可靠的模型。让脚本做验证，让文件做证据，让 hook 做拦截——不让模型自报数据。

---

## 五层架构

```
~/.claude/
│
├── CLAUDE.md              ← 核心指令（精简 ~38 行，每 session 注入）
│
├── rules/                 ← L1 边界：约束规则（渐进式披露）
│   ├── 00-core.md         ←     四条铁律 + Lint First + 验证闭环
│   ├── 01-hdl.md          ←     HDL 编码规范
│   ├── 02-python.md       ←     Python 开发规范
│   ├── 03-debugging.md    ←     调试方法论
│   ├── 04-security.md     ←     安全准则（禁止/需确认操作）
│   ├── 05-workflow-trigger.md  ← 关键词→工作流映射
│   └── 06-cognition.md    ← L4: 7 种推理模式定义
│
├── engine/                ← L1 边界：hooks + scripts + 工具链
│   ├── config.path.sh     ←     路径配置（被 6 个脚本 source）
│   ├── hooks/
│   │   ├── hook-config.json     ← Hook 启用/禁用配置
│   │   ├── run-hook.cjs         ← Hook 运行器
│   │   ├── pre-commit-lint.js   ← 提交前 lint
│   │   ├── diff-size-gate.js    ← diff 大小门禁
│   │   ├── lint-auto-gate.js    ← 停止时自动 lint
│   │   ├── memory-track.sh      ← 记忆时间戳/清理
│   │   ├── resolve-plugin-path.sh   ← ECC 插件路径解析
│   │   └── frustration-detector.cjs ← L4: 挫败检测 + 模式切换
│   ├── scripts/
│   │   ├── semantic-search.cjs  ← L2: TF-IDF 语义检索
│   │   ├── code-graph-index.cjs ← L2: 代码图谱（13350 符号）
│   │   ├── memory-retrieve.sh   ← L2: 四工具统一检索入口
│   │   ├── runtime-state.cjs    ← L3: 运行时状态管理器
│   │   ├── agent-context-budget.cjs   ← 上下文预算 + 智能压缩
│   │   ├── agent-context-watchdog.cjs ← Agent 上下文监测
│   │   ├── ctx-checkpoint.sh          ← 压缩前自动 checkpoint
│   │   ├── memory-cleanup.sh          ← 记忆清理（14/90 天生命周期）
│   │   ├── memory-link.sh             ← 记忆关联图管理
│   │   └── ecc-root-resolver.cjs      ← ECC 插件根路径共享解析
│   ├── schemas/           ← JSON Schema（20 个定义文件）
│   └── mcp/               ← MCP 服务器二进制
│
├── memory/                ← L2 记忆：活跃记忆
│   ├── learnings/         ←     永久经验教训
│   ├── errors/            ←     错误记录（90 天寿命）
│   ├── projects/          ←     项目级记忆
│   ├── references/        ←     跨项目参考链接
│   └── archive/           ←     已归档历史
│
├── knowledge/             ← L2 记忆：领域知识库
│   ├── primary/           ←     核心领域（FPGA / Python / MATLAB）
│   ├── references/        ←     系统文档索引 + skills-catalog
│   ├── docs/              ←     技术文档与模板
│   └── archive/           ←     原始资料归档
│
├── var/                   ← L3 交接：运行时状态（.gitignore，可清理）
│   ├── index/             ←     语义索引 + 代码图谱 + 运行时状态
│   │   ├── semantic-index.json  ← 186 篇文档 TF-IDF 向量
│   │   ├── code-graph.json      ← 13350 符号/4750 边
│   │   └── runtime-state.json   ← sessionId/失败计数/推理模式
│   ├── active-task.yaml   ←     任务协议（交接层核心）
│   ├── work/              ←     session 工作记忆
│   ├── sessions/          ←     session 快照
│   ├── plugins/           ←     插件缓存
│   └── plans/             ←     计划文件
│
├── skills/                ← L5 技能：Skill + 工作流 + Agent 角色
│   ├── start/             ←     /start — session 初始化仪式
│   ├── handoff/           ←     /handoff — session 收尾仪式
│   ├── hdl-coding/        ←     HDL 编码技能
│   ├── tdd/               ←     测试驱动开发
│   ├── code-review/       ←     代码审查
│   ├── debugging/         ←     系统化调试
│   ├── workflows/         ←     多 Agent 工作流定义
│   ├── agents/            ←     Agent 角色定义（17 个）
│   └── ...                ←     更多技能
│
└── settings.local.json    ← 本地 Hook 注册 + 权限配置 + 插件开关
```

---

## L1 边界层：Hook 门禁系统

> CLAUDE.md 写承诺，hooks 写执行。承诺可以被合理化，执行不可以。

### 9 种 Hook 事件

| 事件 | 触发时机 | 用途 |
|:-----|:---------|:-----|
| `SessionStart` | 新 session 开局 | 恢复上下文、加载插件引导 |
| `PreToolUse` | 每次工具调用前 | 命令验证、lint 检查、挫败检测 |
| `PostToolUse` | 每次工具调用后 | 质量门禁、观测记录、上下文监控 |
| `PostToolUseFailure` | 工具调用失败 | MCP 健康检查、自动重连 |
| `Stop` | 每次响应结束 | 批量格式化、类型检查、成本跟踪、session 持久化 |
| `PostStop` | 停止后 | 异步清理 |
| `PostMessage` | 用户新消息 | 记忆时间戳 |
| `PreCompact` | 上下文压缩前 | 状态持久化 |
| `SessionEnd` | session 结束 | 生命周期标记 |

### 39 个注册 Hook

- **本地 hooks**（`engine/hooks/`）：pre-commit-lint, diff-size-gate, frustration-detector, lint-auto-gate, memory-track 等
- **ECC 插件 hooks**（`var/plugins/marketplaces/ecc/scripts/hooks/`，47 个）：通过 `plugin-hook-bootstrap.js` 加载

### 安全拦截（settings.local.json deny）

| 操作 | 拦截行为 |
|:-----|:---------|
| `git push --force` / `-f` | 拒绝 |
| `git reset --hard` | 拒绝 |
| `git clean -fd` | 拒绝 |
| `git branch -D` | 拒绝 |
| `rm -rf /` / `rm -rf ~` | 拒绝 |
| `git push origin main/master` | 拒绝 |
| `git push --delete` / `git push origin :*` | 拒绝 |
| `git commit --amend` | 拒绝 |

---

## L2 记忆层：四工具检索

四工具覆盖域 **0 重叠**，每个场景只有一个正确工具：

| 工具 | 场景 | 实现 | 速度 |
|:-----|:-----|:------|:-----|
| `grep` | 精确字段名 / URL / 环境变量 | Claude 原生 | <100ms |
| `semantic-search` | 跨词同义 / 概念召回 / "记得有个决策" | TF-IDF + 中文 char n-gram | <500ms |
| `code-graph` | 调用链 / import 关系 / 模块实例 | 正则 AST（5 种语言解析器） | <1s |
| `git log` | 谁何时改过 / 时间轴查询 | Claude 原生 | <100ms |

### 使用方式

```bash
# 语义检索
node engine/scripts/semantic-search.cjs query "你的问题" --top 5

# 代码图谱查询
node engine/scripts/code-graph-index.cjs query "函数名"

# 四工具统一入口
bash engine/scripts/memory-retrieve.sh "搜索关键词"
```

### 语义索引状态

- 186 篇文档已索引（`memory/` + `knowledge/primary/` + `knowledge/docs/` + `knowledge/references/`）
- 2555 文件已解析，13350 符号，4750 边（`engine/` + `skills/` + `rules/`）
- 索引位置：`var/index/{semantic-index,code-graph,runtime-state}.json`

---

## L3 交接层：双轨任务状态

每 session 开局自动恢复上下文，收尾自动保存进度。

### 协议轨（人类可读）

`var/active-task.yaml` — YAML 格式，记录：

```yaml
active_plan: "当前功能"
completed_steps:
  - "日期: 完成事项"
next_3_steps:
  - "下一步"
blocked_on: []
cognitive:
  failure_count: 0
  current_mode: "推理模式"
recent_log:
  - "日期: 关键决策"
```

### 状态轨（机器可测）

`var/index/runtime-state.json` — hook 自动维护：

```json
{
  "sessionId": "...",
  "failureCount": 0,
  "currentMode": "",
  "toolCalls": [],
  "failureHistory": [],
  "cognitive": {}
}
```

### 生命周期

| /start（开局） | /handoff（收尾） |
|:--------------|:----------------|
| 读 active-task.yaml | 写 active-task.yaml |
| 读 git log + status | 写 session 日志到 var/work/ |
| 读 memory-retrieve 四工具 | flush runtime-state |
| 输出 Briefing（≤35 行） | 输出 Handoff Report（≤15 行） |

---

## L4 认知层：7 种推理模式

> **核心原则**：失败是系统级信号，应触发模式切换，不是给模型加压。

### 模式表

| 模式 | 适用场景 | 方法 |
|:-----|:---------|:-----|
| 根因分析 | 修 bug、查事故 | 5-Why + 同类模式扫描 |
| 第一性原理 | 新建功能、设计方案 | 质疑→删除→简化→加速→自动化 |
| 减法 | 重构、清理 | 删除优先，不增新抽象 |
| 搜索优先 | 根因未知、领域不熟 | 先查后判，不猜测 |
| 倒推 | 新模块设计 | 从用户终态倒推接口 |
| 证据驱动 | 性能优化、方案选型 | 基准→修改→测量→结论 |
| 闭环 | 默认模式、部署运维 | 定目标→追过程→拿结果 |

### 自动切换机制

`frustration-detector` hook 监听挫败关键词（20+ 中英模式），命中后：

1. 累计失败计数到 `runtime-state.json`
2. ≥3 次失败 → 自动建议切换到根因分析
3. ≥5 次失败 → 自动建议切换到第一性原理
4. 输出模式切换声明：`🔄 切换到 [模式] 模式，原因：...`

详见 `rules/06-cognition.md`。

---

## L5 技能层：13 核心技能 + 17 Agent 角色

### 核心 Skill（slash 命令）

| Skill | 场景 | 触发词 |
|:------|:-----|:-------|
| `/start` | 新 session 开局 | 开始 / 继续上次 / 恢复进度 |
| `/handoff` | session 收尾 | 结束 / 收工 / 保存进度 |
| `/project-init` | FPGA 项目/模块脚手架 | 新建项目 / 添加模块 |
| `/hdl-coding` | RTL 编写、Testbench | 写RTL / 写TB |
| `/rtl-gen` | RTL 快速代码生成 | 生成RTL / 代码模板 |
| `/tdd` | 测试驱动开发 | TDD / 先写测试 |
| `/code-review` | 代码审查 | 审查代码 / 代码质量 |
| `/debugging` | 系统化调试 | 调试 / 查bug / 报错 |
| `/rag-skill` | 知识库检索 | 查知识 / 找参考 |
| `/code-search` | 统一代码搜索 | 搜索代码 / 找函数 |
| `/git-expert` | Git 操作 | Git / 提交 / 分支 |
| `/python-hardware-debug` | 星座图/EVM/频偏 | 硬件调试 / 星座图 |
| `/doc-gen` | 文档生成 | 文档 / README |

完整列表：`knowledge/references/skills-catalog.md`

### Agent 角色（Workflow 子 agent）

17 个定义文件在 `skills/agents/`，供 Workflow 系统 `agent('prompt', {agentType: '...'})` 调用：

| 分类 | 角色 |
|:-----|:-----|
| **core/** | architect / developer / planner / qa / context-compressor / reflection-agent / technical-writer / general-assistant |
| **domain/** | data-scientist / python-pro |
| **orchestrators/** | master-orchestrator |
| **specialized/** | advanced-debugging / code-reviewer / code-simplifier / memory-manager / performance-engineer / researcher |

### 工作流（多 Agent 编排）

`skills/workflows/` 下 6 个工作流定义：

| 工作流 | Phase 数 | 用途 |
|:-------|:---------|:-----|
| `hdl-coding-workflow` | 8 | RTL 全流程（算法→架构→定点→TB→RTL→回归→审查→报告） |
| `code-review-workflow` | 2 | 两轮审查（正确性→代码质量） |
| `architecture-review-skill-workflow` | 4 | 多 Agent 架构审查 |
| `rag-skill-workflow` | 1 | 知识库检索 |
| `security-review-workflow` | 1 | 安全审查 |
| `debug-retrospective` | 1 | 调试回顾 |

---

## MCP 服务器

| MCP | 触发条件 | 功能 |
|:----|:---------|:-----|
| `matlab` | .m 文件、golden model、定点化 | MATLAB 代码分析/执行/测试 |
| `mcp-pdf` | PDF 文档操作 | 读取/编辑/合并/签名 |

---

## 设计原则

### 1. Context Engineering

> 提示工程优化"模型看到什么"，上下文工程优化"什么时刻让模型看到什么、什么不让它看到"。

每层都在操纵 context，时机和目的不同：

| 层 | 操纵对象 | 时机 |
|:---|:---------|:-----|
| L1 hooks | 工具调用前后注入/拦截 | 每次工具调用 |
| L2 记忆 | 从历史召回什么进 context | 按需检索 |
| L3 交接 | 上 session 的什么信息带到下 session | session 边界 |
| L4 认知 | 失败信号注入新框架 | 挫败检测命中 |
| L5 技能 | 任务应让模型接触什么信息、什么顺序 | 用户触发 |

### 2. 不要做模型的代打

> 把规则告诉模型，让模型选；不要做模型的代打。

- 四工具各自场景 clear-cut → Claude 自己学选
- 技能触发词在 SKILL.md description 里 → Claude 按语义匹配
- Hook 拒绝是物理拦截 → Claude 看不到逻辑，无法绕过

### 3. 脱敏

所有 git 跟踪文件不得包含用户主目录路径。使用 `os.homedir()` 动态解算（见 `settings.local.json` 中的 hook 命令）。

---

## 快速入口

| 你要做的事 | 入口 |
|-----------|------|
| 理解核心规则 | `rules/00-core.md` |
| 安全规则 | `rules/04-security.md` |
| 认知层（推理模式） | `rules/06-cognition.md` |
| 查知识库 | 使用 `/rag-skill` |
| 查技能列表 | `knowledge/references/skills-catalog.md` |
| 查完整索引 | `knowledge/references/reference-index.md` |
| 看当前进度 | `var/active-task.yaml` |
| 查运行时状态 | `node engine/scripts/runtime-state.cjs get` |
| 查 Agent 上下文预算 | `node engine/scripts/agent-context-budget.cjs tier <agentType>` |
| 查 Agent 上下文健康 | `node engine/scripts/agent-context-watchdog.cjs health` |
| 查 Agent spawn 记录 | `node engine/scripts/agent-context-watchdog.cjs status` |
| 语义检索 | `node engine/scripts/semantic-search.cjs query "关键词"` |
| 新 session 开局 | `/start` |
| Session 收尾 | `/handoff` |
| 清理运行时 | `rm -rf var/*`（不会丢代码）|

## 维护

由 Claude Code 自动维护。遇到问题检查 `engine/hooks/` 日志。

提交前 lint 自动运行（`pre-commit-lint.js`）。diff 大小超过阈值会被阻断（`diff-size-gate.js`）。
