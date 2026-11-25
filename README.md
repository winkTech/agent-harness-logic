# Agent Harness Logic (`logical-paradox`)

**跨宿主的 AI Coding Agent 工程护栏与持久化运行时插件**：一套引擎同时驱动 **Claude Code / Antigravity / Codex / Grok / WorkBuddy** 五大宿主，把安全拦截、独立验证闭环、SQLite 持久化记忆、CodeGraph 代码图谱、交互式维护控制台与可插拔领域技能包收敛为标准插件。

> **核心哲学**：用可靠的系统承载不可靠的模型。让脚本做验证，让文件做证据，让 Hook 做拦截——**绝不让模型自报测试通过**。

---

## 核心能力全景

| 能力支柱 | 解决什么问题 | 核心机制 |
|---|---|---|
| **1. 风险分级护栏（R0–R3）与安全底座** | 防止 Agent 误删文件、强推主分支、绕过测试、篡改核心规则或泄露密钥 | `PreToolUse` 进程内门禁路由；R0–R3 风险分级与高危人工签核；危险命令与受保护文件（Golden/密钥/配置）阻断；Antigravity 插件目录施加 **OS 级只读 ACL**（Windows NTFS RX / POSIX `0555/0444`），运行态状态隔离至 `~/.logical-paradox/` |
| **2. 独立验证闭环（Evidence-Driven）** | 杜绝模型“改完代码嘴上说 PASS”或用 `echo PASS` / `make clean` 蒙混过关 | 写代码后自动置待验证标记（按项目隔离），仅认 `PostToolUse` 真实测试命令成功输出与客观退出码，否则阻断交付并要求补跑验证；同步记录工具透明度账本 |
| **3. 持久化记忆 + Dream + Skill-Evolve** | 解决跨会话失忆、重复踩同一个坑、经验难以沉淀为规则 | 内建 `node:sqlite` + FTS5/TF-IDF 检索与作用域硬隔离；按需召回已验证经验并追踪暴露→应用→结果归因；`Dream` 后台蒸馏候选经验（须人工批准才晋升规则），`Skill-Evolve` 消费失败/纠偏信号提出技能改进提案 |
| **4. CodeGraph 与 MCP App 控制台** | 让 Agent 看懂跨文件符号依赖，让人在侧边栏一眼掌控门禁与健康度 | 内置 `codegraph` MCP（代码符号/调用图查询）+ SEP-1865 **Harness Maintenance Console**（Antigravity 侧边栏/全局视图实时展示记忆健康度、消费者水位、待验门禁与 ACL 状态；签核/重置/维护按钮对模型严格不可见） |
| **5. 18 个通用工程技能 + 可插拔域包** | 既开箱服务任意软件工程项目，又可按需叠加垂直领域专家能力 | **Core（18 通用技能）**：`tdd`、`debugging`、`code-review`、`security-review`、`brainstorming`、`grilling`、`git-expert`、`code-search`、`modern-python`、`test-generator`、`start`、`handoff` 等；**Office Pack（4 技能）**与 **FPGA Pack（7 技能 + 6 专职子智能体 + EDA/Vivado 治理）** 均可按需裁剪或整包卸载 |
| **6. 五宿主统一插件引擎** | 切换 Agent 工具时无需重写规则、Hook、技能和记忆库 | 统一 `harness-event-v1` 载荷归一与宿主方言表；同一引擎与判罚覆盖 Claude Code、Antigravity、Codex、Grok、WorkBuddy；单源渲染零漂移 |

---

## 快速开始（3 种接入路径，按需选择）

> **前置依赖**：Node.js **>= 22.5**（使用内建 `node:sqlite`，零 npm 外部依赖安装）、Git；可选 Python 3.12+（用于部分校验/测试）。

### 路径 A：30 秒插件即插即用（最简，零侵入现有配置）

适合不想修改本机全局配置、想直接试用标准插件的用户：

```bash
git clone https://github.com/winkTech/agent-harness-logic.git
cd agent-harness-logic

# 1. 选择你需要的域包构建标准便携插件（非 FPGA 用户推荐 core 或 core,office）
node core/engine/scripts/sync-plugin-dist.cjs --packs=core
# 完整版（含 Office + FPGA）：npm run dist:build
```

- **Claude Code**：直接加载标准插件目录（不改你的 `~/.claude/settings.json` 与 API 密钥）：
  ```bash
  claude --plugin-dir ./dist/plugin
  ```
- **Antigravity**：将自包含便携包复制到插件目录即可在 Customizations 中启用（零本机绝对路径耦合，运行数据自动落在 `${PLUGIN_DATA}` / `~/.logical-paradox/`）：
  - 源目录：`./dist/antigravity-plugin`
  - 目标目录：`~/.gemini/config/plugins/logical-paradox`（Windows 为 `%USERPROFILE%\.gemini\config\plugins\logical-paradox`）
- **Claude / Codex / Grok Marketplace**：仓库内置 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`、`.grok-plugin/marketplace.json`，指向 `./dist/plugin`。

### 路径 B：1 分钟统一 CLI 接入（推荐长期使用）

仓库提供跨平台（Windows / macOS / Linux）零依赖统一入口 `scripts/connect.cjs`，先体检再一键接入：

```bash
# 1. 环境与五宿主自动体检（只读）
npm run doctor

# 2. 按需选择域包接入指定宿主（示例为通用软件工程版 --packs core）
npm run connect -- claude-code --packs core            # 构建 dist/plugin 并输出 claude --plugin-dir 命令（默认不改 settings.json）
npm run connect -- antigravity --packs core --refresh  # 方案 A 瘦链接 + OS 只读 ACL 封固 + MCP 热刷新
npm run connect -- antigravity --portable --packs core # 或部署自包含便携独立包
npm run connect -- codex                               # 安装 Codex 插件并拉起原生 Hook 信任审核
npm run connect -- grok --packs core                   # 渲染 ~/.grok/hooks.json + 8/8 静态冒烟
npm run connect -- workbuddy                           # 渲染 workbuddy.hooks.json

# 3. 任意时刻做只读零漂移校验（不写盘）
npm run connect -- all --check
```

> **安全承诺（Claude Code 用户级配置保护）**：`npm run connect -- claude-code` 默认走 `--mode plugin`，**完全不触碰 `~/.claude/settings.json`**。如需将 Hook 写入用户级 `settings.json`，请显式传入 `--mode user`（仅更新 `hooks` 段，完整保留已有 `env` 与密钥）；如需从用户级迁移到纯插件模式避免双跑，可使用 `node core/engine/scripts/render-hook-settings.cjs --remove-user-hooks`（自动 0600 备份，可用 `--restore-user-hooks` 一键还原）。

### 路径 C：AI 引导式零心智安装

直接把仓库路径告诉任意 Coding Agent，发送一句话：

> **“请阅读 `SETUP.md`，先探测本机环境，再一步步帮我完成接入。”**

Agent 会先跑只读环境探针，逐项询问宿主与域包偏好，再给出可回退的安装计划并完成校验。

---

## 五宿主支持矩阵

| 宿主 | 默认接入方式 | 产物 / 发现位置 | 校验命令 | 宿主说明 |
|---|---|---|---|---|
| **Claude Code** | `--plugin-dir ./dist/plugin` 或 `--mode user` | `dist/plugin/` 或 `~/.claude/settings.json` + `~/.claude/skills/` | `npm run connect -- claude-code --check` | [hosts/claude-code/README.md](hosts/claude-code/README.md) |
| **Antigravity** | 方案 A 瘦链接 + OS 只读 ACL，或 `--portable` 独立包 | `~/.gemini/config/plugins/logical-paradox/` | `npm run antigravity:connect -- --check` | [hosts/antigravity/README.md](hosts/antigravity/README.md) |
| **Codex** | 原生插件安装 + Hook 信任审核（Trust all and continue） | `~/.codex/hooks.json` + `~/.codex/AGENTS.md` + `~/.codex/skills/` | `npm run codex:connect -- --check` | [hosts/codex/README.md](hosts/codex/README.md) |
| **Grok** | 剖面投影（长钩子自动降级为异步 spool 消费，启动 `<5s`） | `~/.grok/hooks.json` + `~/.agents/skills/` | `npm run connect -- grok --check` | [hosts/grok/README.md](hosts/grok/README.md) |
| **WorkBuddy** | 同源渲染传输层标注（`--transport workbuddy`） | `core/engine/hooks/workbuddy.hooks.json` | `npm run connect -- workbuddy --check` | [hosts/claude-code/README.md](hosts/claude-code/README.md) |

---

## 泛用性与模块化域包（Core / Office / FPGA）

本仓库通过严格分层保证**核心引擎 100% 领域中立**（由 `layer-boundary.cjs` 机器执法，0 违规）：无论你做 Web、后端、Python、Rust、嵌入式还是芯片/FPGA，都可以按需选用：

| Profile (`--packs` / `HARNESS_PACKS`) | 包含技能 | 包含 MCP | 包含子智能体与域规则 | 适用人群 |
|---|---|---|---|---|
| **`core`** | 18 个通用软件工程技能 | `codegraph`（含 Harness Console） | 仅 `core/rules/`（0 领域假设） | **绝大多数通用软件工程师（推荐默认试用）** |
| **`core,office`** | 18 通用 + 4 文档技能（`doc-gen` / `pdf` / `presentation` / `markitdown-converter`） | `codegraph` + `mcp-pdf` | `core/rules/` | 需要高频处理文档/PDF/PPT 的工程师 |
| **`all`**（构建默认） | 全部 28 技能（+ 7 个 FPGA/HDL 技能） | `codegraph` + `mcp-pdf` + `matlab` | `core/rules/` + `packs/fpga/`（6 专职子智能体、Vivado/HDL 规则与 CBB 资产） | FPGA / ASIC / 算法协同工程师 |

- **运行时完全卸载域包**：设置环境变量 `HARNESS_PACKS_DISABLED=1` 或 `HARNESS_PACKS=core`，引擎内全部 FPGA 规则表（综合红线、仿真治理、RTL 保护路径）自动静默降级为空，不影响任何通用门禁与记忆能力。
- **MATLAB MCP 可选即插即用**：仅启用 `fpga` 域包且本机安装 MATLAB 与 MathWorks MATLAB MCP Server（放 PATH、`packs/fpga/tools/` 或通过 `MATLAB_MCP_SERVER` 指定路径）时启用；未安装时工具列表自动为空，不报错。可用 `node packs/fpga/tools/check-matlab-mcp.cjs --manifest=dist/plugin/.codex-mcp.json` 单独验证。
- **扩展自定义域包**：在 `packs/<your-domain>/` 下按 `skills/`、`rules/`、`config/`、`agents/` 结构放置内容，即可被 `pack-config.cjs` 与 `sync-skills.cjs` 自动发现并通过 `--packs core,<your-domain>` 打包分发。
- **状态目录隔离**：插件模式运行时状态（SQLite 数据库、门禁文件、透明度账本、语义索引）统一写入 `HARNESS_STATE_DIR` / `${PLUGIN_DATA}` / `~/.logical-paradox/`，**绝不污染插件安装目录或目标业务代码库**。

---

## 架构概览

```
宿主层 (Claude Code / Antigravity / Codex / Grok / WorkBuddy)
  │  各宿主原生 Hook 注册面 + MCP 配置（单源渲染，零漂移）
  ▼
Transport 归一层 (core/engine/scripts/transport/ & hosts/antigravity/bridge.cjs)
  │  统一事件协议 (harness-event-v1) 与工具名/退出码方言翻译
  ▼
核心引擎 (core/engine/) ── 完全宿主无关、领域无关
  ├─ 安全与门禁：preflight-router / bash-safety-guard / file-protection-guard / verification-gate / risk-policy
  ├─ 记忆与进化：SQLite (FTS5) + TF-IDF 语义检索 / Dream 蒸馏 / Skill-Evolve / 归因退役 / 周报健康度
  ├─ 观测与交互：透明度账本 / CodeGraph MCP / Harness Console MCP App / OS 只读 ACL 封固
  └─ 跨宿主等价验证：同一恶意样例集（hosts/tests/malicious-samples.jsonl）跨路径判罚 100% 一致
  ▼
可插拔域包 (packs/<domain>/)
  ├─ packs/office/ ── 文档/PDF/PPT/格式转换技能
  └─ packs/fpga/   ── HDL/RTL/Vivado 规则、技能、子智能体、工程资产与治理
```

### Hook 拓扑（契约面）

| 事件 | 引擎入口 |
|---|---|
| `UserPromptSubmit` | prompt-context.cjs：同进程合并规则 capsule、只读事实查询；实际注入另记 exposure |
| `PreToolUse` | preflight-router.cjs（进程内路由） |
| `PostToolUseFailure` | postflight-router.cjs（同步状态与失败记忆）+ postflight-observer.cjs（异步失败遥测/弱归因观察） |
| `SessionStart` | session-bootstrap.cjs（单进程恢复/Dream/isolation）+ 到期维护（async，仅 startup） |
| `Stop` | stop-summary.cjs（同步上下文/进度）+ postflight-observer.cjs（异步透明度/成本/Skill-Evolve） |

> Antigravity 宿主额外通过 `hosts/antigravity/bridge.cjs` 桥接 `PreInvocation`（分层投递确定性 `[harness-capsule]`，检索长正文隔离落盘防上下文污染）与 `PostToolUse` 延迟转录结算。

---

## 记忆治理与维护入口

- 记忆 / Dream / Hook 遥测 / 维护与晋升边界：[core/rules/05-harness.md](core/rules/05-harness.md)
- **Dream 人工审批护栏**：Dream 学习产出的是候选（candidate）——须人工批准（approval）后才晋升为规则，无自主规则写入。
- 到期维护：`memory-knowledge-maintenance.cjs`（`--dry-run` 预览 / `--execute` 清理过期事实、对账、重建索引与周报；Grok 剖面由 spool 消费者调度）
- 规则晋升候选账本：`harness-rule-candidates.cjs`
- 健康度与遥测巡检：`memory-health-check.cjs`（`--json` / `--fix`）与 `harness-telemetry-prune.cjs`（只读识别零命中低置信度事实与零加载晋升规则）
- `memory-sqlite-sync.cjs` 处于 dormant（未注册）状态，不参与运行时。

---

## 质量门禁与本地验证（Windows & Linux 双 OS CI）

```bash
npm run doctor                                                      # 环境、五宿主、ACL 与记忆健康体检
npm run check                                                       # 全量 fail-closed CI 门禁（静态+边界+注册+渲染+SLA+覆盖率）
node core/engine/scripts/test-hooks/run-all-tests.cjs --no-persist  # 全量回归测试（含跨宿主/ACL/MCP App/Pack 契约）
npm run antigravity:test                                            # Antigravity 冻结基线 + 38 类对抗探针 + 5 事件冒烟
node core/engine/scripts/bench-refactor.cjs --phase 2               # 跨宿主等价与传输层行为门
node core/engine/scripts/bench-refactor.cjs --phase 4               # 分发脱敏（D-1）与插件结构（D-2）校验
```

---

## 目录速览

```
core/engine/          宿主无关引擎（hooks / scripts / sqlite / schemas / mcp / parsers）
core/rules/           通用工程规则真源（00-core / 03-gates / 04-git / 05-harness）
core/skills/          18 个通用核心技能真源
packs/office/         办公文档域包（doc-gen / markitdown-converter / pdf / presentation）
packs/fpga/           FPGA/HDL 域包（skills / agents / rules / config / tools / engineering-assets）
hosts/                五宿主适配真源（claude-code / antigravity / codex / grok / tests）
scripts/              统一跨平台接入与体检 CLI（scripts/connect.cjs）及兼容脚本包装器
dist/                 sync-plugin-dist.cjs 生成的标准插件与便携包（gitignore，可重建）
docs/                 架构设计文档、归档与发布检查清单（docs/release-checklist.md）
SETUP.md              给 AI Coding Agent 阅读的交互式引导安装手册
```

---

## 常见故障排查

| 现象 | 原因与解决 |
|---|---|
| 启动报错 `Cannot find module 'node:sqlite'` | Node.js 版本低于 22.5，请升级至 Node 22.17+（推荐 22 LTS 或 24）后重跑 `npm run doctor` |
| Claude Code 提示“用户级 `settings.json` 与插件双跑” | 若改用插件模式，跑 `node core/engine/scripts/render-hook-settings.cjs --remove-user-hooks` 移除用户级重复 Hook（保留全部密钥，可 `--restore-user-hooks` 恢复） |
| Antigravity 更新插件提示 `EPERM` | 插件目录已施加 OS 只读 ACL 保护；请使用 `npm run antigravity:connect -- --refresh`（自动解封→更新→重封固），排查时可临时用 `--unseal` |
| Codex 修改 Hook 后未生效 | Codex 要求对变更后的 Hook 做原生信任确认；运行 `npm run codex:connect` 并在审核页选择 **Trust all and continue** |
| 记忆健康度扣分 | 在 Antigravity 侧边栏打开 **Harness Console** 查看扣分项并点击「执行维护」，或终端运行 `node core/engine/scripts/memory-health-check.cjs` 查看明细 |

## License

MIT
