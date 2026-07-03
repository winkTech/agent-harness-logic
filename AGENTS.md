# Codex 配置

## ⛔ 唯一铁律：指令绝对优先

**每次 Edit/Write/Bash/Agent/Workflow 前，必须输出：**

```
行动: [要做什么]
用户指令: "[原文中的哪一句]"
匹配: ✅ / ⚠️
门禁: 🚦需求澄清[ ✅ / ❌ ] 🧪验证质量[ ✅ / ❌ / N/A ]
```

**门禁检查**（Write/Edit 新代码文件前）：
- 🚦 新 `.sv`/`.v`/`.py` → `var/gates/requirements-gate.json` status=completed？未完成 → 先澄清
- 🧪 新 `tb_*`/`test_*` → `var/gates/verification-quality.json` status=completed？未完成 → 先画像+场景

**不匹配 → 停下 + 偏差报告 + 等确认。效率不优先于合规。**

---

## 🏭 四检查点（收到项目需求后的强制流程）

> **规则不是背景噪音。每个检查点必须输出可见产物，不可跳过。**

### 检查点 0：知识库检索（设计前）

```
[0.1] Glob knowledge/**/*.sv,*.v,*.py  →  Grep 功能关键词搜 knowledge/
[0.2] Read 最相关 2-5 个示例全文
[0.3] Read skills/hdl-coding/SKILL.md（HDL 项目）
[0.4] 输出「示例分析」：命名模式 / 代码结构 / 接口风格 / 位宽约定
      + 引用来源：每个模式 → 示例文件:行号
[0.5] 知识库无相关 → 告知用户 + 询问参考项目
```

### 检查点 1：设计方案（编码前）

```
[1.1] 输出设计方案：
      - 接口定义：端口列表（精确到 bit）+ 时序波形
      - 微架构：FSM 状态图 + 流水线级数 + 数据通路位宽
      - 示例对标：每个决策 → 知识库示例:行号
      - 规则对标：每个决策 → hdl-coding 具体条款
[1.2] 方案有模糊 → 「待澄清清单」一次性问完
[1.3] 用户确认 → 方可编码
```

### 检查点 2：编码自检（Write 前）

```
✅ ri_ 输入寄存 → hdl-coding §1.2    对标示例: ___
✅ ro_ 输出寄存 → hdl-coding §1.3    对标示例: ___
✅ 三段式FSM  → hdl-coding §4      对标示例: ___
✅ 同步复位   → hdl-coding §1.1    对标示例: ___
✅ 无锁存器   → hdl-coding §8      if→else, case→default
✅ 位宽匹配   → hdl-coding §5
```

### 检查点 3：验证闭环（编码后）

```
功能验证（仿真/pytest）≠ 语法检查（vlog -lint/ruff check）
→ 规则见 rules/03-gates.md 门禁二
→ Hook: verification-gate.cjs（编辑后未验证 → exit 2 阻断）
```

---

## 规则索引

| 文件 | 内容 | 加载 |
|:-----|:-----|:-----|
| `rules/00-core.md` | 铁律 + 四检查点 + Lint First + 验证闭环 | 始终 |
| `rules/01-hdl.md` | HDL 五条红线 + 命名 + 模板参考 | .sv/.v |
| `rules/02-python.md` | Python ruff + 硬件调试 | .py |
| `rules/03-gates.md` | 两道门禁（需求澄清 + 验证质量）含触发/退出/阻断 | 始终 |
| `rules/04-git.md` | Git 提交/分支规范 | commit/push |
| `rules/archive/` | 低频规则（调试/安全/绘图/TDD等） | 按需 Read |

---

## 技能

| Skill | 触发 |
|:------|:-----|
| `/hdl-coding` | 写 RTL / TB |
| `/debugging` | 调查 / debug |
| `/code-review` | 审查 / review |
| `/rag-skill` | 查知识库 |
| `/git-expert` | git / 提交 |
| `/start` `/handoff` | 开局 / 收尾 |
| 完整列表 | `knowledge/references/skills-catalog.md` |

## 工作流

```js
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['模块名']}})
Workflow({name: 'code-review-workflow', args: {files: ['文件']}})
Workflow({name: 'architecture-review-workflow', args: {targets: ['路径']}})
```

---

## 🔒 验证门禁（硬约束）

编辑文件后 → 标记「待验证」→ 下一非验证命令被 `exit 2` 拦截。
**功能验证 ≠ 语法检查**。`ruff check` / `vlog -lint` 只清标记，不算验证。
绕过：删 `var/verify-gate.json`

## 🏗️ 三道闸门

```
闸门1 Write Gate  — 写入前: TB-First / ri_ro_扫描 / GM保护
闸门2 Bash Gate   — 运行时: 安全拦截 / 验证门禁 / 资源预算
闸门3 Commit Gate — 提交前: vlog-lint / 综合违规 / 命名 / 扇出 / ruff / GM保护
```

## 🪝 Hook 注册表

| 事件 | 功能 |
|:-----|:-----|
| `PreToolUse(*)` | 认知层（rule-loader / memory-retrieve / frustration-detector） |
| `PreToolUse(Bash)` | 验证门禁 + 安全门禁 + diff-size + resource-budget |
| `PreToolUse(Edit\|Write)` | 文件保护 + 需求澄清门禁 + 验证质量门禁 |
| `PreToolUse(Write)` | HDL-Gate + requirements-gate-guard + verification-quality-guard |
| `PostToolUse(Edit\|Write)` | 验证门禁状态标记 |
| `SessionStart` | 交接注入 + 记忆健康 + 知识库统计 + 隔离检查 |
| `Stop` | Lint 自动 + 上下文压力预警 |

## 🔄 上下文管理

| 场景 | 操作 |
|:-----|:-----|
| 同问题纠正两次仍不对 | `/clear` 重开 |
| 切换不相关任务 | 先 `/clear` |
| 聊了很久 | `/compact` |
| Codex 开始变笨 | `/context` → `/compact` |
