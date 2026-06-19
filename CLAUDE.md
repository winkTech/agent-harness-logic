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

### 上下文自动管理

当 `context-monitor-gate` 输出以下信号时，必须自动响应：

| 信号 | 自动动作 |
|:-----|:---------|
| `level: "AUTO_COMPACT"` + `autoAction: "subagent"` | → 立即 spawn 子 agent 承载当前任务继续，主 session 执行 `/compact`。**不等待用户确认，用户已授权** |
| `level: "AUTO_COMPACT"`（无 subagent 信号） | → 在下次回复尾部追加 `/compact` focus 建议 |
| `level: "RED"` | → 优先执行 `/compact`，压缩完成前不开始新任务 |

> 子 agent 创建时传入 `continuationPrompt` 作为任务描述，确保进度不丢失。子 agent 完成后，只取结论摘要合并回主 session。

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
| `rules/06-cognition.md` | 7种推理模式 | 卡住/不对/再试试/换一种 |
| `rules/07-system.md` | 安装/下载 | 涉及安装 |
| `rules/08-constraints.md` | Golden Model 保护 | 修改 matlab/python |
| `rules/09-search-tools.md` | 代码搜索 | 搜索/查找 |
| `rules/10-drawing.md` | 绘图 | 画图/架构图 |
| `rules/11-git.md` | Git 操作 | commit/push |
| `rules/12-tdd.md` | 测试驱动 | TDD/写测试 |

## 技能

| Skill | 场景 | 触发词 | 来源 |
|:------|:-----|:---------|:-----|
| `/start` | 新 session 开局 | 开始 / 继续 | 本地 |
| `/handoff` | session 收尾 | 结束 / 收工 | 本地 |
| `/hdl-coding` | RTL 编写 | 写RTL / 写TB | 本地 |
| `/debugging` | 系统化调试 | 调查 / debug | 本地 |
| `/code-review` | 代码审查 | 审查 / review | 本地 |
| `/rag-skill` | 知识库检索 | 查知识 / 参考文档 | 本地 |
| `/code-search` | 代码搜索 | 搜代码 / 找文件 | 本地 |
| `/git-expert` | Git 操作 | git / 提交 | 本地 |
| `/deep-research` | 深度研究 | 技术调研 / 方案对比 | 本地 |
| `/brainstorming` | 头脑风暴 | 多方案 / 想点子 | 本地 |
| `/presentation` | 图表/PPT | 架构图 / 汇报 | 本地 |
| `/pdf` | PDF编辑/填表/签名 | 编辑PDF/填表/加签名/合并/水印 | 本地 |
| `/doc-gen` | 文档生成 | 生成文档 / README | 本地 |
| `/tdd` | 测试驱动开发 | TDD / 测试优先 | 本地 |
| `/test-generator` | 测试生成 | 生成 testbench | 本地 |
| `/security-review` | 安全审查 | 安全 / 认证 / 密钥 | 本地 |
| `/rtl-gen` | RTL 代码生成 | 生成RTL模板 | 本地 |
| `/modern-python` | Python 开发 | Python 3.12+ | 本地 |
| `/python-hardware-debug` | 硬件调试Python | 星座图 / EVM / 频偏 | 本地 |
| `/verify` | 验证改动 | 验证 / 确认效果 | 内置 |
| `/simplify` | 代码简化 | 简化 / 重构 | 内置 |
| `/browser` | 浏览器自动化 | 网页交互 / 抓取 | 本地 |
| `/agent-management` | Agent 管理 | 管理技能 / 编排 | 本地 |
| `/markitdown-converter` | 格式转换 | 转Markdown | 本地 |
| `/project-init` | 项目脚手架 | 新建工程 / 加模块 | 本地 |
| `/update-config` | 配置管理 | 改设置 / 加hook | 内置 |
| `/keybindings-help` | 快捷键 | 改快捷键 | 内置 |
| `/loop` | 定时循环 | 定期检查 / 轮询 | 内置 |
| `/claude-api` | Claude API 参考 | 模型 / API / 价格 | 内置 |
| `/fewer-permission-prompts` | 权限优化 | 减少确认 | 内置 |
| `/run` | 运行应用 | 启动 / 运行 | 内置 |
| `/init` | 项目初始化 | 初始化 | 内置 |
| 完整详情 | `knowledge/references/skills-catalog.md` | — | 本地 |

## 工作流

```js
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['模块名']}})     // HDL 全流程 (推荐)
Workflow({name: 'hdl-coding-workflow', args: {modules: ['模块名']}})          // 别名，同上
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['viterbi'], lite: true}})  // Lite 模式
Workflow({name: 'code-review-workflow', args: {files: ['文件路径']}})          // 代码审查
Workflow({name: 'architecture-review-workflow', args: {targets: ['目标路径']}}) // 架构审查
Workflow({name: 'security-review-workflow', args: {targets: ['src/']}})        // 安全审查
Workflow({name: 'rag-skill-workflow', args: {query: ['关键词']}})  // 知识库深度检索
```

详见 `rules/05-workflow-trigger.md`。

---

## 上下文压缩规则

> `/compact` 和自动压缩时，本段指示什么必须保留。

**[MUST] 压缩时必须保留以下信息：**
- 当前工作流 Phase 和进度（已完成/进行中/待办）
- 已修改/新建的文件列表（路径 + 变更摘要）
- 关键架构/算法决策（尤其是未记录到文档的）
- 待修复的问题列表（bug、未完成的审查意见）
- **可丢弃**：已完成任务的中间调试过程、已修正的错误尝试、已通过的临时讨论
