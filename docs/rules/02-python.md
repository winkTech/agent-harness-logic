---
name: python-rules
description: "Python 编码规则 — 工具链、调试"
priority: L1
trigger: ".py, Python, python"
skip: "不涉及 Python"
---

# Python 编码规则

> L1 优先级：涉及 Python 开发时自动加载。

- 使用 `ruff` 进行 lint（`ruff check`）
  - 不适用于一次性探针脚本与 `var/`、系统临时目录下的产物：它们不进版本控制，也不进 CI，跑 lint 只是消耗。判据是"会不会被提交"，不是"是不是 .py"。
- 调试硬件相关 Python（星座图/EVM/频偏）使用 `/python-hardware-debug` skill
- 参见 `skills/python-hardware-debug/SKILL.md`

### 违反后果
未运行 ruff check 提交 Python 代码 → CI 会拦截，增加修复成本。
