---
name: verification-must-be-functional
description: 验证闭环铁律 — 编辑后的验证必须做功能验证，不能只跑机械的 lint/type-check 来应付门禁
metadata:
  type: feedback
  domain: meta
---

# 验证必须是功能验证

**规则**：修改代码后，"验证"指**用真实场景确认修复生效**，而不是跑个 `ruff check` / `pytest --no-run` 清掉门禁标记。

## 错误做法（之前的行为）

```
改 memory-sqlite-sync.js → 跑 ruff check（清门禁） → 继续改下一个
```

- `ruff check` 只检查语法，完全不验证 memory 文件是否能写入 SQLite
- 门禁标记清除，但功能可能还是坏的
- 这叫 "tick the box"，不叫验证

## 正确做法

```
改 memory-sqlite-sync.js → 创建临时 .md 文件
  → 用标准 Hook 格式 stdin 调用脚本
  → 查 SQLite 确认记录写入
  → 清理测试数据
  → 通过后才算"已验证"
```

## 验证门禁的真实含义

验证门禁（verification-gate）的 `VERIFY_PATTERNS` 只用于匹配命令文本，它无法判断命令是否真的做了功能验证。所以：

- **对开发者**：建立自我要求——每次跑验证命令前先问"这个命令能证明我的改动有效吗？"
- **对门禁**：它只是一个安全网，不是验证质量的标准

## 具体到不同修改类型

| 修改类型 | 功能验证方式 | 不可接受的应付方式 |
|:---------|:-------------|:------------------|
| HDL RTL | vsim 仿真 + 波形检查 | `vlog -lint` 只检查语法 |
| Python 逻辑 | pytest 真实测试用例 | `ruff check` 只检查格式 |
| Hook 脚本 | 模拟 stdin 调用 + 检查效果 | node --check 只检查语法 |
| 配置修改 | 重启 + 确认行为变化 | cat 确认文件内容 |

**Why:** 之前三番五次出现"改完跑个 lint 就当验证了"的情况，导致功能缺陷被漏过。
**How to apply:** 编辑文件后，选择与改动对应的最小功能验证方式，跑通后再提交。
