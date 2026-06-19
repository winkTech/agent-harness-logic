---
name: hard-constraints
description: "硬约束规则 — 违反 [MUST NOT] = FAIL，全局强制执行"
priority: L2
trigger: "修改 matlab/python/golden 文件时"
skip: "永不跳过"
---

# 硬约束规则

> L0 优先级：违反任何一条 [MUST NOT] = **FAIL**。
> 文件保护模式在 `engine/scripts/hooks/file-protection-guard.cjs` 的 `PROTECTED_PATTERNS` 中定义。

## §1 浮点 Golden Model 保护

- **[MUST NOT]** 修改 `matlab/` 下的任何文件
- **[MUST NOT]** 修改 `python/` 中名称含 `golden` / `fixed_point` 的文件
- **[MUST NOT]** 修改 `scripts/` 中名称含 `golden` 的文件

发现 Golden Model 与 RTL 不符 → 先确认 RTL 是否正确 → 确认有 bug 则在 issue 中记录。

## §2 系统文件保护

- **[MUST NOT]** 修改 `settings.json` / `settings.local.json` 中与安全/认证相关的字段
- **[MUST NOT]** 提交包含真实 API token / secret 的代码

## §3 Golden Model 强制算法对齐

- **[MUST]** RTL 实现的**算法方向**必须与 Golden Model 一致
  - 允许定点量化精度损失，**不允许算法方向偏离**（硬判决 vs 软判决、时域 vs 频域）
- **[MUST]** RTL 方案与 Golden Model 算法路径有差异 → 在 Phase 2 记录为"算法方向不一致"并解决后才能进 RTL 编码

## 项目级附加约束

放在 `memory/projects/<project-name>/constraints.md` 中。
