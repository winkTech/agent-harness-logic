# Git 操作规则

> L2 优先级。涉及 commit/push 时加载。

## 提交
- `commit` 前跑 lint + 功能验证通过
- 暂存只加相关文件，禁止 `git add -A` / `git add .`
- 格式: `<type>(<scope>): <描述>` 例: `fix(scrambler): 修复位宽溢出`

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
