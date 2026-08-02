---
name: git-rules
description: "Git commit, branch, and push rules."
priority: L2
trigger: "git, commit, push, branch, merge, rebase"
skip: ""
---

# Git 操作规则

> L2 优先级。涉及 commit/push 时加载。

## 提交
- `commit` 前跑 lint + 功能验证通过
  - 纯文档或配置提交按 `CLAUDE.md` 验证节办：检查结构、解析和引用完整性即可，不要求跑无关的代码测试。
- 暂存只加相关文件，禁止 `git add -A` / `git add .`
  - 工作树里有他人或并行会话的在途改动时尤其重要：逐个列出本次改动的文件，不靠通配。
  - 并行会话在跑时，暂存与提交连成一步，不要先 `add` 再等。暂存区是仓库级共享状态：只要另一方用了 `git add -A` 或 `git commit -a`，你先暂存就等于把文件交给了下一个提交的人（2026-08-01 实测，9 个文件被卷进无关提交）。
- 格式: `<type>(<scope>): <描述>` 例: `fix(scrambler): 修复位宽溢出`
- 提交前看一眼 diff 的**比例**而非只看规模：几行的改动产出全文件 diff，说明用了整文件重写而非最小编辑，应回退重做。`diff-size-gate` 会在 commit 时点名这类文件，但它是 advisory，拦不住也不代表可以放行。

## 分支
- `main` 只接 squash merge，不在上面直接开发
- 功能分支: `feat/<name>` / `fix/<desc>` / `refactor/<module>`
- 合并前 rebase 到最新 main

## 禁止
- `git push --force`（除非用户明确要求）
- `git reset --hard`（除非用户明确要求）
- 直接 push main

## .gitignore 必须含
`*.vcd`, `*.wlf`, `transcript`, `work/`, `__pycache__/`, `.venv/`, `*.swp`
