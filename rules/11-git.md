---
name: git-rules
description: "Git 操作规则 — 分支管理、提交流程、提交规范"
priority: L2
trigger: "git / 提交 / 推送 / 分支 / 合并 / 暂存 / commit / push / pull / merge / rebase"
skip: "纯代码编写 / 仿真调试 / 文档阅读 / 架构设计 / 绘图"
---

# Git 操作规则

> L2 优先级：涉及 Git 操作时自动加载。

## 提交流程

- `commit` 前必须运行 lint/syntax check，确保代码无语法错误
- `commit` 前必须验证仿真通过（如 `vsim -c -do run.do`）
- 暂存区只添加与本次修改相关的文件，禁止使用 `git add -A` 或 `git add .`
- 提交信息格式：`<类型>(<范围>): <描述>`
  - `fix(scrambler): 修复位宽溢出`
  - `feat(fft): 添加 64 点流水线支持`

## 分支管理策略

- `main` 分支只接受 squash merge，不接受直接提交
- 功能开发在独立分支上进行，命名规则：
  - `feat/<功能名>` — 新功能
  - `fix/<bug简述>` — 修 bug
  - `refactor/<模块名>` — 重构
- 合并到 main 前先 rebase 到最新的 main，解决冲突后再合并
- 分支合并后删除远端和本地分支

## .gitignore 必需包含项

- **FPGA**: `*.vcd`, `*.vcd.lxt`, `*.wlf`, `transcript`, `vsim.wlf`, `work/`
- **Python**: `__pycache__/`, `*.pyc`, `.venv/`, `*.egg-info/`
- **系统**: `.DS_Store`, `Thumbs.db`, `*.swp`

## 禁止操作

- `git push --force` — 需用户明确确认
- `git reset --hard` — 需用户明确确认
- 不要在 main 分支上直接开发

## 参考

- 完整 Git Skill：`skills/git-expert/SKILL.md`
- 详细规范：`skills/git-expert/references/git-rule.md`
