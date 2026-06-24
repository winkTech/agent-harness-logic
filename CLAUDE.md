# Claude Code 配置

## ⛔ 唯一铁律：指令绝对优先

**每次 Edit/Write/Bash/Agent/Workflow 前，必须输出：**

```
行动: [要做什么]
用户指令: "[原文中的哪一句]"
匹配: ✅ / ⚠️
```

**不匹配 → 立即停下，输出偏差报告，等用户确认。**

违规场景（零容忍）：
- 用户说"逐模块验证" → 批量改所有模块
- 用户说"四角色分工" → 一个人干所有活
- 用户说"重构" → 只改信号名
- 用户说"先分析" → 直接改代码

**核心：效率不优先于合规。宁可慢一步，不可错一步。**

---

## 规则索引（按需加载，不主动读）

| 文件 | 场景 | 加载条件 |
|:-----|:-----|:---------|
| `rules/00-core.md` | 四条铁律 + Lint First + 验证闭环 | 始终加载 |
| `rules/01-hdl.md` | RTL/TB 编写 | 涉及 .sv/.v |
| `rules/02-python.md` | Python 开发 | 涉及 .py |
| `rules/03-debugging.md` | 调试排错 | 仿真报错/波形不对 |
| `rules/04-security.md` | 安全敏感操作 | auth/token/encrypt 等 |
| `rules/05-workflow-trigger.md` | 工作流触发 | 关键词命中 |
| `rules/07-system.md` | 安装/下载 | 涉及安装 |
| `rules/08-constraints.md` | Golden Model 保护 | 修改 matlab/python |
| `rules/09-search-tools.md` | 代码搜索 | 搜索/查找 |
| `rules/10-drawing.md` | 绘图 | 画图/架构图 |
| `rules/11-git.md` | Git 操作 | commit/push |
| `rules/12-tdd.md` | 测试驱动 | TDD/写测试 |

## 技能

| Skill | 场景 | 触发词 |
|:------|:-----|:-------|
| `/start` | 新 session 开局 | 开始 / 继续 |
| `/handoff` | session 收尾 | 结束 / 收工 |
| `/hdl-coding` | RTL 编写 | 写RTL / 写TB |
| `/debugging` | 系统化调试 | 调查 / debug |
| `/code-review` | 代码审查 | 审查 / review |
| `/rag-skill` | 知识库检索 | 查知识 / 参考文档 |
| `/code-search` | 代码搜索 | 搜代码 / 找文件 |
| `/git-expert` | Git 操作 | git / 提交 |
| `/deep-research` | 深度研究 | 技术调研 / 方案对比 |
| `/brainstorming` | 头脑风暴 | 多方案 / 想点子 |
| `/presentation` | 图表/PPT | 架构图 / 汇报 |
| `/doc-gen` | 文档生成 | 生成文档 / README |
| `/tdd` | 测试驱动开发 | TDD / 测试优先 |
| `/test-generator` | 测试生成 | 生成 testbench |
| `/security-review` | 安全审查 | 安全 / 认证 / 密钥 |
| `/rtl-gen` | RTL 代码生成 | 生成RTL模板 |
| `/modern-python` | Python 开发 | Python 3.12+ |
| `/python-hardware-debug` | 硬件调试Python | 星座图 / EVM / 频偏 |
| `/verify` | 验证改动 | 验证 / 确认效果 |
| `/simplify` | 代码简化 | 简化 / 重构 |
| `/browser` | 浏览器自动化 | 网页交互 / 抓取 |
| `/agent-management` | Agent 管理 | 管理技能 / 编排 |
| `/markitdown-converter` | 格式转换 | 转Markdown |
| `/project-init` | 项目脚手架 | 新建工程 / 加模块 |
| `/update-config` | 配置管理 | 改设置 / 加hook |
| `/keybindings-help` | 快捷键 | 改快捷键 |
| `/loop` | 定时循环 | 定期检查 / 轮询 |
| `/claude-api` | Claude API 参考 | 模型 / API / 价格 |
| `/fewer-permission-prompts` | 权限优化 | 减少确认 |
| `/run` | 运行应用 | 启动 / 运行 |
| `/init` | 项目初始化 | 初始化 |
| 完整详情 | `knowledge/references/skills-catalog.md` | — |

## 工作流

```js
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['模块名']}})     // HDL 全流程 (推荐)
Workflow({name: 'hdl-coding-workflow', args: {modules: ['模块名']}})          // 别名，同上
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['viterbi'], lite: true}})  // Lite 模式
Workflow({name: 'code-review-workflow', args: {files: ['文件路径']}})          // 代码审查
Workflow({name: 'architecture-review-workflow', args: {targets: ['目标路径']}}) // 架构审查
Workflow({name: 'security-review-workflow', args: {targets: ['src/']}})        // 安全审查
```

详见 `rules/05-workflow-trigger.md`。

---

## 🔄 上下文管理铁律

**Context window 是最金贵的资源。—— 读文件会很快塞满它，塞满后 Claude 会变笨。**

| 场景 | 正确操作 |
|:-----|:---------|
| 同一个问题纠正两次仍不对 | **无条件 `/clear` 重开**，带上已学到的教训写新提示 |
| 切到不相关的任务 | 先 `/clear`，别在旧会话里混新活 |
| 同一任务聊了很长时间 | `/compact` 压缩，可加指令指定保留重点 |
| 感觉 Claude 开始「变笨」/忘记早期内容 | 先 `/context` 看占用，再 `/compact` |
| 开始新会话 / 跨天继续 | 用 `claude --resume` 续上个会话，或 `/clear` 重开 |

## 🛡️ 权限与安全须知

**⚠️ 当前 `defaultMode: bypassPermissions` — 已跳过所有权限检查。**
- 此模式**不防提示注入**，任何来自外部内容的恶意指令都可能被误执行
- 必须在隔离环境（容器/VM/WSL）中才安全
- 建议：日常开发切到 `auto` 模式（有分类器兜底），仅 CI/容器中切回 bypass

**敏感文件保护（Windows 无沙箱）**：
- `deny` 规则只能拦 Claude 的内置工具，**挡不住脚本子进程绕道**
- 例：`deny: Read(.env)` 拦不住 `python -c "print(open('.env').read())"`
- 所以 `.env`/`secrets/` 等敏感文件不要放在项目目录内，或用 Git-Crypt/SOPS 加密
- Hook 是 `deny` 失效后的第二道防线：`PreToolUse` + `exit 2` 能硬拦截

## 🔒 验证门禁（硬约束）

编辑文件后未运行验证 → 下一步操作被 `exit 2` 硬拦截。

| 事件 | 行为 |
|:-----|:-----|
| 编辑文件后 | 自动标记「待验证」 |
| 运行 `pytest`/`vlog`/`make`/`ruff check` 等 | ✅ 放行 + 清除标记 |
| 运行 `ls`/`cd`/`git status` 等只读命令 | ✅ 放行（保留标记） |
| 运行其他命令（写文件/编译/删除等） | ❌ exit 2 拦截，提示先验证 |
| 绕过方法 | 删除 `~/.claude/var/verify-gate.json` |

## 🏗️ 三道闸门架构

所有规则通过三道闸门执行，而非散落的单个钩子：

```
闸门1: Write Gate (PreToolUse + PostToolUse on Write/Edit)
  ├─ 写入前: Testbench-First 检查 (新建 HDL 模块需先有 TB)
  ├─ 写入后: 代码扫描 (initial/命名/逻辑级数/扇出)
  └─ 写入后: 黄金模型保护检查
  覆盖: 01-hdl.md / 08-constraints.md / RTL_DESIGN_RULE.md

闸门2: Bash Gate (PreToolUse on Bash)
  ├─ 安全检查: 拦截 curl @.env / python open matlab / 数据泄露
  ├─ 验证门禁: 编辑后未验证 → 阻断非只读操作
  └─ 资源限制: FPGA 资源预算 / diff 大小门禁
  覆盖: 04-security.md / 00-core.md(验证闭环)

闸门3: Commit Gate (PreToolUse on Bash -> git commit)
  ├─ HDL 语法检查 (vlog -lint)
  ├─ 综合违规检查 (initial/disable/force)
  ├─ HDL 命名规范检查 (ri_/ro_)
  ├─ HDL 逻辑级数/扇出检查
  ├─ 黄金模型保护检查
  ├─ Python lint 检查 (ruff check)
  └─ 验证门禁状态检查
  效果: 违规全部列在一张表中 -> exit 2 -> 阻断提交
  覆盖: 00-core.md / 01-hdl.md / 02-python.md / 08-constraints.md
```

## 🪝 Hook 注册表## 🪝 Hook 注册表

当前引擎已注册的 Hook 事件：

| 事件 | 功能 | 文件 |
|:-----|:-----|:-----|
| `SessionStart` | 交接注入 + 记忆健康 + 知识库 + 隔离检查 | `state-resume.cjs`, `isolation-check.cjs` |
| `PreToolUse(*)` | 认知层（规则加载/记忆检索/挫败检测） | `rule-loader.cjs`, `memory-retrieve-hook.cjs` |
| `PreToolUse(Bash)` | Git 门禁 + Lint 预检 + 资源预算 + **验证门禁** | `diff-size-gate.js`, `verification-gate.cjs` |
| `PreToolUse(Bash)` | Bash 子进程安全门禁 | `bash-safety-guard.cjs` |
| `PreToolUse(Edit\|Write)` | 黄金模型保护 + 自动备份 + 配置保护 | `file-protection-guard.cjs`, `config-protection.js` |
| `PostToolUse(*)` | 上下文监控 + 质量门 + 技能跟踪 | `ecc-context-monitor.js`, `quality-gate.js` |
| `PostToolUse(Edit\|Write)` | 验证门禁状态标记 | `verification-gate.cjs` |
| `Stop(*)` | 自动 Lint + 格式化 + 状态持久化 | `lint-auto-gate.js`, `session-end.js` |

**新增 Hook**:
- `session:isolation-check` — 启动时检测 bypassPermissions + 非隔离环境并警告
- `stop:context-pressure-warn` — 上下文压力大时建议 `/compact`
- `pre:bash:verification-gate` — 验证闭环硬门禁 (exit 2 拦截)
- `post:verification-gate` — 编辑文件后标记「待验证」状态
