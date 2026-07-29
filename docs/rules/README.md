# docs/rules/ — 核心规则

> 6 个核心规则 + `docs/rules-archive/` 低频规则。**规则是检查点的输入，不是背景噪音。**

## 为什么不在 `.claude/rules/`

平台把 `.claude/rules/*.md` 当作常驻全局指令**全文注入**每个会话。放在那里的规则
会和 `rule-loader.cjs` 按需注入的 capsule 形成双重加权：同一份规则既常驻又被摘要，
既浪费常驻预算，也让 `00-core.md` 自己写的"capsule 足够时不读取全文"失效。

移到 `docs/rules/` 后，capsule 是唯一的路由信号，全文只在确有需要时按路径 `Read`。
`rule-loader.cjs` 的 `RULES_DIR` 优先指向本目录，找不到时回退旧路径。

这和下面 `docs/rules-archive/` 的迁移是同一个问题的两次发作——第一次是低频规则，
第二次是核心规则。

## 核心规则

| 文件 | 优先级 | 内容 | 加载条件 |
|:-----|:-------|:-----|:---------|
| `00-core.md` | L0 | 常驻契约指针、按需路由与加载纪律 | 始终（进 capsule） |
| `01-hdl.md` | L1 | HDL 五条红线 + 命名 + 模板参考 | .sv/.v |
| `02-python.md` | L1 | Python ruff + 硬件调试 | .py |
| `03-gates.md` | L0 | 新资产或契约变化的需求与验证质量门禁 | 按上下文 |
| `04-git.md` | L2 | Git 提交/分支规范 | commit/push |
| `05-harness.md` | L1 | 记忆、Dream、Hook 注册与修缮、维护、检索与规则晋升边界 | memory/Dream/hook/harness/maintenance/settings.json/注册/CI/门禁/镜像 |

## docs/rules-archive/ — 低频规则（按需 Read）

> 这些文件原先放在 `rules/archive/`。README 当时声称"不自动加载"，
> 但实测**被全量注入**了常驻上下文（约 24k 字符 ≈ 8k tokens），
> 且其中 3 份与 `CLAUDE.md` 的授权边界正面冲突。
> 已移出 `rules/`，改为按需 `Read docs/rules-archive/<file>`。

| 文件 | 场景 |
|:-----|:-----|
| `03-debugging.md` | 仿真报错/波形不对 |
| `04-security.md` | auth/token/encrypt |
| `05-workflow-trigger.md` | 关键词→工作流映射 |
| `06-cognition.md` | 7 种推理模式 |
| `07-system.md` | 安装/下载 |
| `08-constraints.md` | Golden Model 保护 |
| `09-search-tools.md` | 代码搜索优先级 |
| `10-drawing.md` | 画图/架构图 |
| `12-tdd.md` | TDD/测试驱动 |
| `13-context-management.md` | 上下文管理 |
| `14-fix-in-place.md` | 文件变体禁止（已由 hook 执行） |

## 开发与观测入口

```bash
node engine/scripts/test-hooks/live-regression-matrix.cjs --live --agents claude,codex --kinds implementation,ambiguous --out var/evals/live-regression
node engine/scripts/transparency-dashboard.cjs --out var/agent-transparency-dashboard.html
```

Hook 实现分层：

- `PreToolUse`：规则/记忆路由、安全与验证门禁、项目目录保护；
- `PreToolUse(Write)`：HDL、RTL 语义、需求澄清和验证质量门禁；
- `PostToolUse`：验证状态、工具链健康和透明度账本；
- `SessionStart` / `Stop`：上下文恢复、健康检查、lint 与账本收尾。

具体启用项以 `settings.json` 和 `settings.local.json` 为准。

## 常驻提示预算

行数与注入量由回归脚本动态统计，不在文档中维护易漂移的快照。
