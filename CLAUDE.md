# Claude Code 配置 v3.2

## 一、通用编码准则

**四条铁律**：
1. **编码前思考** — 明确假设，不确定就提问，有更简单方案就说
2. **简单优先** — 最小代码解决问题，不添加未要求的功能
3. **精准修改** — 只触及必须部分，匹配现有风格
4. **目标驱动** — 定义成功标准，循环直到验证通过

## 二、执行规则

### 语言
- 所有输出使用中文（特殊字符/信号除外）

### Lint First（写完代码必须检查）
所有代码提交前必须通过语法检查。Verilog/SV: `vlog -lint <file>`，Python: `ruff check`，MATLAB: 使用 MCP `check_matlab_code`。仅改 Markdown/注释/README 时免检。

## 三、核心规则

### 新项目 / 新模块启动
- 用户表示"新建项目/工程" → 调用 `/project-init` 技能（自动执行 `scripts/init-project.sh`）
- 用户表示"添加模块" → 调用 `/project-init` 技能的 module 子流程（自动执行 `scripts/init-module.sh`）
- 详细规范见 `knowledge/primary/cross-project-experience.md`

### 建项目后要点
1. 先 git init + 首提交"init: 项目名"
2. 新建模块立刻写 TB，遵循 Testbench-First
3. 每加一个模块，同步更新仿真目录和文档

## 四、核心 Skill 与 MCP

| Skill | 位置 | 场景 |
|-------|------|------|
| 项目初始化 | `project-init/SKILL.md` | FPGA 项目/模块脚手架 |
| HDL编码 | `hdl-coding/SKILL.md` | RTL 编写、Testbench |
| TDD工作流 | `tdd/references/tdd-workflow-local.md` | 测试驱动开发 |
| PDF读取 | `rag-skill/references/pdf_reading.md` | 文档分析 |
| Python调试 | `python-hardware-debug/SKILL.md` | 星座图/EVM/频偏/采数 |

| MCP | 传输 | 触发条件 |
|:----|:---:|:---------|
| matlab | stdio | .m 文件执行、golden model 验证、BER/SNR 仿真、定点化分析 |
| mcp-pdf | stdio | PDF 文档操作 |

## 五、参考资料

`references/reference-index.md` — 完整索引（记忆系统/Agent 机制/错误恢复/插件管理/会话管理/高级功能/版本管理/工具脚本/性能基准）

知识库：`knowledge/INDEX.md`，优先使用 rag-skill 检索。

## 六、版本

v3.3 (2026-06-06): 新增 §7 工作流调用规则 + 升级检查点 + 安全触发绑定

## 七、工作流调用规则

> 定义各工作流的触发条件，确保流程不被跳过。

### 7.1 关键词 → 工作流映射

| 用户表述 | 触发的工作流 | 说明 |
|:---------|:------------|:------|
| 新模块/写RTL/写TB/算法实现/定点 | `hdl-coding-workflow` | 必须从 Phase 0 或 1 开始，不可跳过架构设计 |
| 审查代码/代码质量/PR审查 | `code-review-workflow` | 先 Pass 1 再 Pass 2 |
| 架构审查/代码库评估/技术债 | `architecture-review-workflow` | 多 Agent 并行审查 |
| 安全审查/认证/密钥/支付/文件上传 | `security-review-workflow` | 独立安全审查流程 |
| HDL 编码时问知识/查参考 | rag-skill（自动 Hook） | 系统侧拦截，无感执行 |

### 7.2 Phase 完成自动触发

```
hdl-coding Phase 6（代码审查）完成
    → 自动加载 code-review-workflow 执行审查
    → code-review Pass 1 中发现架构问题
        → 自动升级到 architecture-review-workflow
    → code-review 涉及安全敏感变更
        → 自动加载 security-review-workflow 补充审查
```

### 7.3 安全敏感关键词自动绑定

遇到以下关键词时，**必须同时加载 security-review-workflow**：
- `auth` / `token` / `password` / `secret` / `api_key` / `credential`
- `payment` / `checkout` / `refund` / ` wallet`
- `upload` / `file upload` / `attachment`
- `encrypt` / `decrypt` / `cipher` / `TLS` / `HTTPS`
- `SQL` / `injection` / `XSS` / `CSRF`

### 7.4 不可跳越红线

- 写 RTL 前必须先过 Phase 1（架构框图）和 Phase 2（定点量化）——不允许直接写代码
- Phase 6 未完成（code-review 未通过）不允许提交
- code-review Pass 1 有阻塞项不允许进入 Pass 2
- 代码库 > 10K LOC 但未做架构审查 → 标记为流程违规
