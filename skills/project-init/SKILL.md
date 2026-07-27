---
name: project-init
description: FPGA 项目/模块初始化 — 建目录结构、EDA检测、Git 仓库、首模块脚手架。
---

# FPGA 项目初始化 Skill

## 触发

| 用户说 | 映射 |
|:-------|:-----|
| "新建项目/工程" | `/init project` |
| "初始化项目 xxx" | `/init project xxx` |
| "加一个模块 xxx" | `/init module xxx` |
| "新建模块" | `/init module xxx` |

---

## 1. `/init project [名称]`

```
[0] 检测 EDA 工具链: node engine/scripts/eda-detect.cjs --json
    → 确认 vlog/xvlog/vivado 可用，告知用户
[1] 确认项目名 + 目标器件（缺省 xc7k325tffg900-2）
[2] 执行: bash engine/scripts/init-project.sh <名称>
    或: node engine/scripts/harness-init.cjs（交互式引导，含 EDA 检测）
[3] git init + git add -A + git commit -m "init: <名称>"
[4] 询问是否创建首模块 → 是则进入 module 流程
```

## 2. `/init module [名称]`

```
[1] 确认模块名 + 位宽（缺省 16）
[2] 执行: bash engine/scripts/init-module.sh <名称> [位宽]
[3] 提示: 写 RTL → 补 TB（检查点 CP0-CP3）→ 仿真验证
```

## 3. 新增模块到已有项目

```
[1] 确认模块名 + 位宽 + 接口
[2] 执行: bash engine/scripts/init-module.sh <名称>
[3] 同步更新仿真文件列表 + 文档
[4] 遵循 HDL 五条红线 (docs/rules/01-hdl.md) + 四检查点 (docs/rules/00-core.md)
```

---

## 引用

| 资源 | 路径 |
|:-----|:-----|
| EDA 检测 | `engine/scripts/eda-detect.cjs --json` |
| 项目脚手架 | `engine/scripts/harness-init.cjs` |
| 项目初始化脚本 | `engine/scripts/init-project.sh` |
| 模块初始化脚本 | `engine/scripts/init-module.sh` |
| 项目目录规范 | `engineering-assets/knowledge/primary/cross-project-experience.md` |
| HDL 红线 | `docs/rules/01-hdl.md` |
| 四检查点 | `docs/rules/00-core.md` |
