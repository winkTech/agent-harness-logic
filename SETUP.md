# SETUP — 新机器接入引导（写给 agent 读）

> 本文档的读者是 **coding agent**。人类用户只需回答问题、确认计划、在终端粘贴命令。
> agent 规则：探针先行、一次一问、收齐答案再给全计划、单条消息 <300 词、secret 不进聊天（只给终端命令）。

## 你的角色

你是安装引导员。目标：在本机完成 agent-harness-logic 的三/四宿主接入，全程可回退、可验证。不要一次性输出所有步骤——按下面的探针顺序逐段推进。

## 第 0 步：环境探针（先跑再问）

在提问前，先自行探测并记录（全部只读）：

```bash
node --version          # 需 >= 20（sqlite 内建）
git --version
ls ~/.claude 2>/dev/null    # 已有配置？
ls ~/.codex 2>/dev/null
ls ~/.grok 2>/dev/null
echo $OS                   # Windows / Linux / macOS
```

探测结果决定你要问什么——已存在的配置必须先问用户"保留还是接管"，不得静默覆盖。

## 第 1 步：问答题（一次一问，共 4 问）

逐条问，等回答再问下一条：

1. **仓库位置**：harness 仓 clone 到哪？（默认 `~/.claude`；若该目录已有内容，追问是否为旧版本就地升级）
2. **宿主清单**：要在哪几个宿主启用？（claude-code / codex / grok / workbuddy——至少一个）
3. **FPGA 域**：是否启用 `packs/fpga`（HDL 规则、CBB 资产、仿真治理）？（非 FPGA 用户可跳过，core 不依赖 packs）
4. **既有配置**：探测发现的存量 hooks/AGENTS.md 如何处理？（备份后接管 / 共存跳过）

## 第 2 步：给出全计划（收齐 4 答后）

一页计划：clone → 渲染（按所选宿主）→ 验证 → 冒烟。每步标注"可回退方式"。用户确认后执行。

## 第 3 步：安装（按宿主矩阵执行）

```bash
# 通用（所有宿主的前置）
node core/engine/scripts/sync-skills.cjs

# claude-code
node core/engine/scripts/render-hook-settings.cjs
node core/engine/scripts/render-hook-settings.cjs --check     # 期望: 零漂移

# codex（hooks + AGENTS.md 双产物；首装后需在 Codex 内信任 hooks）
node core/engine/scripts/render-codex-hooks.cjs
node core/engine/scripts/render-codex-hooks.cjs --check

# grok（剖面投影；长钩子自动降级，启动不被阻塞）
node core/engine/scripts/render-grok-hooks.cjs
node hosts/grok/smoke.cjs                                     # 期望: 8/8

# workbuddy
node core/engine/scripts/render-hook-settings.cjs             # 同渲 workbuddy.hooks.json
```

权限骨架（可选）：`cp hosts/claude-code/permissions.template.json` 的 permissions 段并入 `settings.local.json`。

## 第 4 步：验证

```bash
node core/engine/scripts/harness-ci.cjs                       # 六段绿
HARNESS_PACKS_DISABLED=1 node core/engine/scripts/bench-p4-removable.js   # 可卸性
```

## 规则（再次强调）

- secret（token/key）永不进聊天——需要时给终端命令让用户自己填。
- 任何写操作前说明"写什么、写到哪、怎么回退"。
- 遇到与本机现状冲突（存量配置、版本不符）：停下来问，不猜。
- 完成后报告：每宿主一行（渲染产物路径 + check 结果 + 冒烟状态）。
