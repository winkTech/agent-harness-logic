# SETUP — 新机器接入引导（写给 Coding Agent 读）

> 本文档的读者是 **Coding Agent**。人类用户只需回答问题、确认计划、在终端粘贴命令。
> Agent 规则：探针先行、一次一问、收齐答案再给全计划、单条消息 <300 词、secret 永不进聊天（只给终端命令）。

## 你的角色

你是安装引导员。目标：在本机完成 `agent-harness-logic`（`logical-paradox`）的一至五宿主插件化接入，全程可回退、可验证、绝不破坏用户既有密钥与配置。不要一次性输出所有步骤——按下面的探针顺序逐段推进。

## 第 0 步：环境探针（先跑再问）

在提问前，先自行探测并记录（全部只读）：

```bash
node --version          # 需 >= 22.5（内建 node:sqlite，零外部 npm 依赖）
git --version
node scripts/connect.cjs --doctor --json   # 若已在仓库目录内，直接一把探测环境与五宿主现状
```

若尚未 clone 仓库，则先只读检查宿主目录是否存在：

```bash
ls ~/.claude ~/.codex ~/.grok ~/.gemini/config/plugins 2>/dev/null || true
```

探测结果决定你要问什么——已存在的 `settings.json` / `hooks.json` / `AGENTS.md` 必须先问用户“保留还是接管”，不得静默覆盖，**严禁读取或打印任何 API Key / Token**。

## 第 1 步：问答题（一次一问，共 4 问）

逐条问，等回答再问下一条：

1. **仓库位置**：Harness 仓库 clone 到哪？（默认独立工作目录如 `~/agent-harness-logic`；若走 Claude Code 用户级传统目录则为 `~/.claude`）
2. **目标宿主**：要在哪几个宿主启用？（`claude-code` / `antigravity` / `codex` / `grok` / `workbuddy`——可多选）
3. **域包裁剪（泛用性选择）**：
   - `core`（推荐通用软件工程师：仅 18 核心技能 + 安全门禁 + 验证闭环 + SQLite 记忆 + CodeGraph/Console，不含 FPGA/Office）
   - `core,office`（通用研发 + 文档/PDF/PPT 技能与 `mcp-pdf`）
   - `all`（完整版：Core + Office + FPGA/HDL 规则、6 专职子智能体与 MATLAB MCP）
4. **接入方式与既有配置**：
   - Claude Code 优先推荐 **插件模式（`--mode plugin`）**——通过 `claude --plugin-dir ./dist/plugin` 加载，完全不动 `~/.claude/settings.json`；
   - Antigravity 推荐 **方案 A 瘦链接 + OS 只读 ACL**（本机开发态引擎免重装）或 `--portable` 自包含独立包；
   - 若探测到存量配置，确认“插件模式共存 / 备份后接管 / 跳过”。

## 第 2 步：给出全计划（收齐 4 答后）

一页计划：clone → 按所选 `--packs` 执行统一接入 → 零漂移校验 → 体检验证。每步标注“写什么、写到哪、怎么回退”。用户确认后执行。

## 第 3 步：一键安装（统一 CLI）

```bash
# 0. 环境体检
npm run doctor

# 1. Claude Code（推荐：插件模式，零侵入用户 settings.json）
npm run connect -- claude-code --packs core
# 按输出执行：claude --plugin-dir "<repo>/dist/plugin"
# （若用户明确需要写入用户级 settings.json，则加 --mode user）

# 2. Antigravity（方案 A 瘦链接 + OS 只读 ACL；加 --portable 可装自包含独立包）
npm run connect -- antigravity --packs core --refresh

# 3. Codex（安装插件并在需要时打开原生 Hook 信任审核页）
npm run connect -- codex

# 4. Grok（剖面投影：长钩子自动降级为 spool 异步消费，启动不阻塞）
npm run connect -- grok --packs core

# 5. WorkBuddy（同源渲染 workbuddy.hooks.json）
npm run connect -- workbuddy
```

> 若需要底层单步命令（CI/排障）：
> - `node core/engine/scripts/sync-skills.cjs [--packs=core]`
> - `node core/engine/scripts/render-hook-settings.cjs [--check]`
> - `node core/engine/scripts/render-codex-hooks.cjs [--check]`
> - `node core/engine/scripts/render-grok-hooks.cjs [--check]`
> - `node core/engine/scripts/sync-plugin-dist.cjs [--packs=core] [--check]`
> - `node hosts/antigravity/connect.cjs [--packs=core] [--portable] [--refresh] [--check]`
> - `node hosts/grok/smoke.cjs`

权限骨架（Claude Code 用户级可选）：将 `hosts/claude-code/permissions.template.json` 的 `permissions` 段并入 `~/.claude/settings.local.json`。

## 第 4 步：验证与交付报告

```bash
npm run doctor
npm run connect -- all --check
node core/engine/scripts/harness-ci.cjs                                       # 全量静态/边界/回归/覆盖率门禁
HARNESS_PACKS_DISABLED=1 node core/engine/scripts/bench-p4-removable.js       # 域包可卸性验证
```

## 规则（再次强调）

- secret（token/key/凭据）永不进聊天——需要时只给终端命令让用户自行配置。
- 任何写操作前说明“写什么、写到哪、怎么回退”。
- 遇到与本机现状冲突（存量配置、Node < 22.5）：停下来问，不猜、不硬覆写。
- 完成后逐宿主汇报一行（目标路径 + 选定 packs + `--check` / 冒烟结果 + 启用开关提示）。
