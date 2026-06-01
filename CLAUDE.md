# Claude Code 配置

> 版本: v2.1 | 更新: 2026-05-31 | 用途: 全局配置，定义 Skill、插件、MCP 调用规则

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
- 按 `git-expert/references/git-rule.md` 管理版本
- 提交前必须 lint 检查：Verilog→`vlog -lint`，Python→`ruff check`，MATLAB→`checkcode()`

### 2.3 设计规则

| 语言 | 规则文件 |
|------|----------|
| HDL | hdl-coding/SKILL.md |
| MATLAB | `hdl-coding/references/matlab-rule.md` |
| Python | `modern-python/references/python-rule.md` |
| 绘图 | `diagram-generator/references/draw-rule.md` |

---

## 三、核心 Skill

### 3.1 HDL编码（自动加载）
- **位置**: `hdl-coding/SKILL.md`
- **场景**: RTL代码编写、Testbench、状态机、流水线、Vivado开发
- **参考**: SKILL.md(核心) → references/(详细)

### 3.2 TDD工作流
- **规范**: `tdd/references/tdd-workflow-local.md`
- **场景**: 新建Python/MATLAB/RTL模块、修复Bug、重构代码

### 3.3 PDF读取分析（自动加载）
- **位置**: `rag-skill/references/pdf_reading.md`
- **方法**: markitdown-converter > pymupdf > OCR

---

## 四、辅助 Skill

### 文档处理

| Skill | 功能 | 场景 |
|-------|------|------|
| markitdown-converter | 多格式转Markdown | PDF/PPT/Word/Excel |
| doc-generator | 文档生成 | 设计文档、测试报告 |
| readme | README生成 | 项目说明 |
| pptx | PPT生成 | 项目汇报 |
| xlsx | Excel生成 | 参数表、结果表 |
| diagram-generator | 图表生成 | 框图、流程图 |

### 代码搜索

| Skill | 功能 | 场景 |
|-------|------|------|
| ripgrep | 快速文本搜索 | 精确匹配信号名 |
| code-semantic-search | 语义搜索 | 按功能描述搜索 |
| codebase-exploration | 代码探索 | 了解架构、模块关系 |

### 开发测试

| Skill | 功能 | 场景 |
|-------|------|------|
| tdd | 测试驱动开发 | RTL/Python/MATLAB |
| test-generator | 测试生成 | Testbench框架 |
| debugging | 系统性调试 | 仿真异常、功能异常 |
| smart-debug | 智能调试 | 复杂bug深度排查 |

### 架构规划

| Skill | 功能 | 场景 |
|-------|------|------|
| architecture-review | 架构评审 | 模块划分、接口设计 |
| brainstorming | 头脑风暴 | 多方案对比 |
| complexity-assessment | 复杂度评估 | 资源、时序分析 |

### 研究分析

| Skill | 功能 | 场景 |
|-------|------|------|
| deep-research | 深度研究 | 技术调研、方案对比 |
| modern-python | 现代Python | Python 3.12+特性 |
| data-scientist | 数据分析 | 仿真结果、性能对比 |

### 代码质量

| Skill | 功能 | 场景 |
|-------|------|------|
| code-quality-expert | 质量检查 | 提交前自检 |
| proactive-audit | 主动审计 | 项目交付前审计 |
| security-review | 安全审查 | 认证、API、敏感数据 |

### 其他

| Skill | 功能 | 场景 |
|-------|------|------|
| git-expert | Git操作 | 复杂Git操作、冲突解决 |
| session-handoff | 会话交接 | 长时间任务、跨会话续接 |
| skill-creator | 技能创建 | 创建/优化Skill |
| find-skills | 技能发现 | 查找可安装技能 |
| subagent-driven-development | 子代理开发 | 执行计划、并行任务 |
| html-ppt-skill | HTML演示文稿 | 创建演示文稿 |

---

## 五、高级功能

### 5.1 Skill调用优先级

| 优先级 | 场景 | 首选 | 备选 |
|--------|------|------|------|
| 1 | 读取PDF | rag-skill | markitdown-converter |
| 2 | PPT/Word/Excel | markitdown-converter | — |
| 3 | 精确搜索 | ripgrep | code-semantic-search |
| 4 | 语义搜索 | code-semantic-search | ripgrep |
| 5 | 简单调试 | debugging | smart-debug |
| 6 | 复杂调试 | smart-debug | debugging |
| 7 | RTL编码 | hdl-coding | — |
| 8 | RTL测试 | tdd + test-generator | — |

### 5.2 工作流模板

**A. PDF→RTL**: rag-skill → markitdown-converter → deep-research → brainstorming → architecture-review → tdd → hdl-coding → doc-generator

**B. 文档分析**: markitdown-converter → rag-skill → code-semantic-search → architecture-review

### 5.3 Agent边界

| Agent | 功能 | 调用条件 |
|-------|------|----------|
| router | 路由分发 | 自动运行 |
| planner | 任务规划 | 3+步骤任务 |
| developer | 代码实现 | 编写代码（最后手段） |
| qa | 测试执行 | 验证Testbench |
| architect | 架构设计 | 模块划分、接口设计 |
| code-reviewer | 代码审查 | 代码写完后自动触发 |
| researcher | 技术调研 | 调研算法方案 |
| advanced-debugging | 复杂调试 | 常规调试无法定位 |

### 5.4 Hook边界

**安全类**（自动运行）: router-tool-lockdown(防越权)、external-content-guard(拦截注入)、dlp-pretool(数据防护)

**质量类**: pre-completion-validation(完成验证)、post-pipeline-self-review(自动审查)

---

## 六、插件管理

### 已安装插件

everything-claude-code(日常)、superpowers(TDD)、code-review(审查)、code-simplifier(重构)、github(Git)、mgrep(搜索)、commit-commands(提交)、skill-creator(技能)、claude-md-management(配置)

### MCP服务器

mcp-pdf(PDF操作)、memory(知识图谱)、context7(文档查询)、playwright(浏览器)

**原则**: 优先本地 → 按需调用 → 结果缓存 → 安全优先

---

## 七、参考资料索引

**HDL编码**: SKILL.md(核心) → references/timing-constraints.md → fpga-optimization.md → fpga-development.md → alg-flow-verilog.md

**其他规则**: tdd/references/tdd-workflow-local.md | hdl-coding/references/matlab-rule.md | modern-python/references/python-rule.md | diagram-generator/references/draw-rule.md | git-expert/references/git-rule.md

**RTL快速参考**: 同步复位 → 输入寄存 → 输出处理 → 跨时钟域 → 信号前缀 → 状态机 → 代码顺序 → 锁存器 → 位宽匹配 → 阻塞/非阻塞

**简化策略**: 状态机合并 → 流水线优化 → 资源共享 → 逻辑简化

---

## 版本历史

- v2.1 (2026-05-31): 精简到200行，保持功能完整性
- v2.0 (2026-05-31): 结构重构，添加目录
- v1.0 (2026-05-30): 初始版本
