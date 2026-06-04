# Mutation Testing（变异测试）

使用 Stryker JS 验证测试质量。通过引入变异体（mutant）并检查测试是否能捕获它们来防止假 GREEN。

## Stryker + Vitest（ESM/TypeScript）

```bash
pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner
```

`stryker.config.json`:
```json
{
  "$schema": "node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "coverageAnalysis": "perTest",
  "thresholds": { "high": 80, "low": 60, "break": 50 }
}
```

```bash
pnpm stryker run
```

## Stryker + node:test（CommonJS/.cjs）

```json
{
  "testRunner": "command",
  "commandRunner": { "command": "node --test" },
  "thresholds": { "high": 80, "low": 60, "break": 50 }
}
```

## 解读结果

- **Killed**: 测试正确捕获了变异 ✓
- **Survived**: 测试未检测到变化 — 需要加强断言
- **No coverage**: 测试未覆盖该代码路径
- **阈值**: high=80(警示), low=60(警告), break=50(失败)
