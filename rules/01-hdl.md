---
name: hdl-rules
description: "HDL 编码规则 — 新项目流程、模块规范"
priority: L1
trigger: ".sv / .v 文件被打开或编辑时自动加载 / 新建项目 / 添加模块 / 初始化项目 / 新建模块 / 脚手架"
skip: "只改文档/配置/Python/MATLAB"
---

# HDL 编码规则

> L1 优先级：涉及 RTL/TB 工作时自动加载。

## 新项目 / 新模块启动

- 用户表示"新建项目/工程" → 调用 `/project-init` 技能
- 用户表示"添加模块" → 调用 `/project-init` 技能的 module 子流程

### 建项目后要点
1. 先 `git init` + 首提交 `"init: 项目名"`
2. 新建模块立刻写 TB，遵循 Testbench-First
3. 每加一个模块，同步更新仿真目录和文档

## 详细规范
- 见 `knowledge/primary/cross-project-experience.md`
- HDL Skill: `skills/hdl-coding/SKILL.md`

### 违反后果
未调用 /project-init 直接写代码 → 项目结构可能不符合规范，需在 review 中修复。
