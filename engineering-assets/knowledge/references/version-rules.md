---
name: version-rules
description: 版本管理规则
metadata:
  type: reference
---

# 版本管理规则

> 详细版本管理规范

---

## 基本规则

- 按 `git-expert/references/git-rule.md` 管理版本
- 提交前必须 lint 检查：
  - Verilog → `vlog -lint`
  - Python → `ruff check`
  - MATLAB → `checkcode()`

---

## 设计规则

| 语言 | 规则文件 |
|------|----------|
| HDL | hdl-coding/SKILL.md |
| MATLAB | `engineering-assets/knowledge/references/matlab-rule.md` |
| Python | `modern-python/references/python-rule.md` |
| 绘图 | `diagram-generator/references/draw-rule.md` |
