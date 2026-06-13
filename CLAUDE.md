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
| 完整列表 | `knowledge/references/skills-catalog.md` | — |

## 工作流

```js
Workflow({name: 'hdl-coding-workflow', args: {modules: ['模块名']}})
Workflow({name: 'code-review-workflow', args: {files: ['文件路径']}})
Workflow({name: 'architecture-review-workflow', args: {targets: ['目标文件']}})
```

详见 `rules/05-workflow-trigger.md`。
