---
name: python-rules
description: "Python 编码规则 — 工具链、调试"
priority: L1
trigger: ".py 文件被打开或编辑时自动加载"
skip: "不涉及 Python"
---

# Python 编码规则

> L1 优先级：涉及 Python 开发时自动加载。

- 使用 `ruff` 进行 lint（`ruff check`）
- 调试硬件相关 Python（星座图/EVM/频偏）使用 `/python-hardware-debug` skill
- 参见 `skills/python-hardware-debug/SKILL.md`

### 违反后果
未运行 ruff check 提交 Python 代码 → CI 会拦截，增加修复成本。
