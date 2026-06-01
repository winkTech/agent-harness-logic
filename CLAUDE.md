# Claude Code 配置

> 版本: v3.0 | 更新: 2026-06-01 | 用途: 全局配置，定义核心规则

---

## 一、通用编码准则

> 来源: [andrej-karpathy-skills](https://github.com/shareAI-lab/andrej-karpathy-skills)

**四条铁律**：
1. **编码前思考** — 明确假设，不确定就提问，有更简单方案就说
2. **简单优先** — 最小代码解决问题，不添加未要求的功能
3. **精准修改** — 只触及必须部分，匹配现有风格
4. **目标驱动** — 定义成功标准，循环直到验证通过

---

## 二、环境配置

### 2.1 语言要求
- 所有输出使用中文（特殊字符/信号除外）

### 2.2 版本管理
- 详细规则：`references/version-rules.md`

---

## 三、核心 Skill

| Skill | 位置 | 场景 |
|-------|------|------|
| HDL编码 | `hdl-coding/SKILL.md` | RTL代码编写、Testbench |
| TDD工作流 | `tdd/references/tdd-workflow-local.md` | 测试驱动开发 |
| PDF读取 | `rag-skill/references/pdf_reading.md` | 文档分析 |

---

## 四、辅助 Skill

完整目录：`references/skills-catalog.md`

---

## 五、高级功能

详细配置：`references/advanced-features.md`

---

## 六、记忆系统

详细规则：`references/memory-system.md`

## 七、会话管理

监控与应对：`references/session-management.md`

---

## 八、插件管理

### 已安装插件

everything-claude-code(日常)、superpowers(TDD)、code-review(审查)、code-simplifier(重构)、github(Git)、mgrep(搜索)、commit-commands(提交)、skill-creator(技能)、claude-md-management(配置)、coding-tutor(编程教程)、compound-engineering(复合工程)

### MCP服务器

mcp-pdf(PDF操作)、memory(知识图谱)、context7(文档查询)、playwright(浏览器)

**原则**: 优先本地 → 按需调用 → 结果缓存 → 安全优先

### 新插件详细说明

`references/new-plugins.md`

---

## 九、参考资料索引

`references/reference-index.md`

---

## 版本历史

- v3.0 (2026-06-01): 模块化重构，详细内容移至 references/ 按需加载
- v2.2 (2026-06-01): 添加新插件适配（coding-tutor、compound-engineering）
- v2.1 (2026-05-31): 精简到200行，保持功能完整性
- v2.0 (2026-05-31): 结构重构，添加目录
- v1.0 (2026-05-30): 初始版本
