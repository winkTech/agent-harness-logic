---
name: core-rules
description: "四条铁律 + 通用编码准则 — 所有 session 必须遵守，不可跳过"
priority: L0
---

# 核心规则

> L0 优先级：所有 session 启动时自动注入，不可跳过。

## 四条铁律

1. **编码前思考** — 明确假设，不确定就提问，有更简单方案就说
2. **简单优先** — 最小代码解决问题，不添加未要求的功能
3. **精准修改** — 只触及必须部分，匹配现有风格
4. **目标驱动** — 定义成功标准，循环直到验证通过

## 执行规则

### 语言
- 所有输出使用中文（特殊字符/信号除外）

### Lint First
所有代码提交前必须通过语法检查：
- Verilog/SV: `vlog -lint <file>`
- Python: `ruff check`
- MATLAB: 使用 MCP `check_matlab_code`
- 仅改 Markdown/注释/README 时免检

### 验证闭环
- 改代码后必须跑对应的验证（类型检查/测试/simulation）
- 不验证不提交
