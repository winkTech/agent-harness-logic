---
name: hard-constraints
description: "硬约束规则 — 违反 [MUST NOT] = FAIL，全局强制执行"
priority: L0
trigger: "任何 session 启动时自动加载"
skip: "永不跳过"
---

# 硬约束规则

> L0 优先级：违反任何一条 [MUST NOT] = **FAIL**。
> 适用于所有 session，与项目无关的全局约束。
> 文件保护模式在 `engine/scripts/hooks/file-protection-guard.cjs` 的 `PROTECTED_PATTERNS` 数组中定义。

---

## 规则格式

```
[MUST NOT] <行为> → 否则 FAIL
```

否定约束（"不要做 X"）天然容易在长上下文衰减。
本规则通过配合 `file-protection-guard` hook 自动执行物理阻断。

---

## §1 浮点 Golden Model 保护

- **[MUST NOT]** 修改 `matlab/` 下的任何文件 → 否则 FAIL
- **[MUST NOT]** 修改 `python/` 中名称含 `golden` / `fixed_point` 的文件 → 否则 FAIL
- **[MUST NOT]** 修改 `scripts/` 中名称含 `golden` 的文件 → 否则 FAIL

**原因**：Golden Model 是算法层面的浮点参考实现，RTL 设计必须围绕它展开，不能反过来改 Golden Model 去适配 RTL。

**如何做**：如果发现 Golden Model 与 RTL 行为不符：
1. 先确认 RTL 是否正确实现了 Golden Model 的逻辑
2. 如果确认 Golden Model 有 bug → 在 issue 中记录，而非直接修改
3. 任何 Golden Model 变更必须经过算法负责人确认

---

## §2 系统文件保护

- **[MUST NOT]** 修改 `settings.json` / `settings.local.json` 中与安全/认证相关的字段 → 否则 FAIL
- **[MUST NOT]** 提交包含真实 API token / secret 的代码 → 否则 FAIL

---

## §3 扩展方式

### 项目级附加约束

项目特定约束放在 `memory/projects/<project-name>/constraints.md`：

```markdown
# <项目名> 额外约束
- [MUST NOT] <项目特定的禁止规则>
```

### 文件保护模式（自动执行）

编辑 `engine/scripts/hooks/file-protection-guard.cjs` 中的 `PROTECTED_PATTERNS` 数组，添加或移除模式：

```js
const PROTECTED_PATTERNS = [
  '**/matlab/**',       // MATLAB golden model
  '**/*golden*',         // Any golden model file
  // ...
];
```

修改后，任何 Write/Edit 操作触及匹配文件都会被 hook 阻断。

---

## §4 与 [MUST] 规则的关系

| 类型 | 格式 | 执行方式 | 违反后果 |
|:-----|:-----|:---------|:---------|
| 肯定约束 | `[MUST] 做 X` | agent 自觉遵守 | 审查不通过 |
| 否定约束 | `[MUST NOT] 做 X` | hook 物理阻断 + agent 自觉 | 操作被拦截 |
