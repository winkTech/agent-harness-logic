---
name: project-init
description: FPGA 项目/模块初始化 — 建目录结构、Git 仓库、首模块脚手架。输入项目名即可。
---

# FPGA 项目初始化 Skill

## 用户意图触发

| 用户说的话 | 映射到 |
|:-----------|:--------|
| "新建一个项目/工程" | `/init project` |
| "初始化项目 xxx" | `/init project xxx` |
| "加一个模块 xxx" | `/init module xxx` |
| "新建模块" | `/init module xxx` |
| `/init` | 交互式引导 |

---

## 流程

### 1. `/init project [名称] [器件]`

```bash
# 步骤:
1. 确认项目名称（可选参数，缺省则提问）
2. 确认目标器件（缺省 xc7k325tffg900-2，可提问）
3. 执行: bash scripts/init-project.sh <名称> [器件]
4. git init + git add -A + git commit -m "init: <名称>"
5. 提问是否创建第一个模块 → 是则进入 module 流程
6. 提示后续: 编辑 README.md、写算法文档、加模块
```

**检查清单**（自动做）:
- [x] `init-project.sh` 执行成功
- [x] git 仓库初始化 + 首提交
- [x] 询问是否创建第一个模块

### 2. `/init module [名称] [位宽]`

```bash
# 步骤:
1. 确认模块名（缺省则提问）
2. 确认位宽（缺省 16）
3. 执行: bash scripts/init-module.sh <名称> [位宽]
4. 提示下一步: 写 RTL 逻辑 → 补 TB 测试用例 → 仿真验证
```

---

## 实现指引

- 使用 `scripts/init-project.sh` 和 `scripts/init-module.sh` 作为底层执行脚本
- 脚本依赖 `cross-project-experience.md` 中定义的目录结构规范
- 脚本执行前检查 $PWD 是否已有 prj/ 目录（避免重复初始化）
- 所有 stdin 交互通过 AI 提问完成（无需脚本 read -p）

---

## 引用

| 资源 | 路径 |
|:-----|:-----|
| 项目目录规范 | `knowledge/primary/cross-project-experience.md` |
| 项目初始化脚本 | `scripts/init-project.sh` |
| 模块初始化脚本 | `scripts/init-module.sh` |
| 文档臃肿教训 | `memory/learnings/doc-bloat-anti-pattern.md` |
