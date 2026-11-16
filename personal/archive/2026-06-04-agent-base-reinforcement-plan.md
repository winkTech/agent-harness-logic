---
name: agent-base-reinforcement-plan
description: Agent 基座加固 + 漏洞修复计划 — 技能瘦身/配置修复/安全加固
metadata:
  type: work
---

# Agent 基座加固计划

## 总体目标

清理冗余技能、修复配置漏洞、加固安全基线。

## 第一阶段：技能清理与瘦身

| 项目 | 处理方案 |
|:-----|:---------|
| **插件缓存 330MB** | 清理 `plugins/` 市场临时目录 + 缓存去重，保留核心插件 |
| **doc-gen / doc-generator** | 合并到 doc-gen，删除 doc-generator |
| **readme** | 已合并到 doc-gen，删除 stub |
| **pptx / html-ppt-skill / presentation** | 合并到 presentation，删除 pptx 和 html-ppt-skill |
| **browser / use-my-browser / agent-browser** | 保留 use-my-browser（完整），删除另外两个 stub |
| **code-xxx 系列** | code-quality-expert / code-semantic-search / codebase-exploration / code-inspect / proactive-audit / complexity-assessment / smart-debug / ripgrep — 合并到 code-inspect 或 debugging |
| **agent-管理系列** | find-skills / skill-creator / session-handoff / subagent-driven-development — 合并到 agent-management |
| **diagram-generator** | 8行 stub，检查引用后决定删除或保留 |

## 第二阶段：配置与钩子修复

| 项目 | 问题 | 修复 |
|:-----|:-----|:-----|
| **CLAUDE.md 描述过时** | 写的 `iverilog`，实际用 `vlog -lint` | CLAUDE.md 改为 `vlog -lint` |
| **.gitignore 重复** | `*.log`（26行）+ `xsim.log` + `vlog.log` + `tr_db.log` 冗余 | 清理 EDA 段重复项，只保留 `*.log` |
| **pre-commit 保护漏洞** | `git commit --no-verify` 可绕过 | 增加检测并提示用户 |
| **pre-commit 路径脆弱** | 非 git 根目录调用可能误报 | 增加 `git rev-parse --show-toplevel` 保护 |

## 第三阶段：安全加固（选做）

| 项目 | 说明 |
|:-----|:-----|
| **settings.local.json 权限审计** | deny 列表缺 `git push --delete`, `gh repo delete` 等 |
| **context-monitor 状态文件清理** | `context/runtime/` 残留状态检查 |
| **插件钩子路径锁** | session-start/end 依赖 everything-claude-code 路径，插件更新可能失效 |

## 执行顺序

瘦身 → 配置 → 安全。预计总工时 2~3 小时。

## 关联记忆

- [[agent-health-audit]] — 健康审查规范
- [[agent-optimization-roadmap]] — 长期优化路线图
- [[agent-evaluation-v7]] — 评估结果明细
