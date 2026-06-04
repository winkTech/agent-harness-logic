# Test-Driven Prompting (TDP)

2026 标准模式：在编写 prompt 之前先定义其输出的验证标准。

## 模式

1. 定义输出格式契约（JSON Schema / 接口类型）
2. 编写验证函数（检查输出是否符合契约）
3. 编写 prompt → 运行 → 验证
4. 不符合契约 → 优化 prompt 直到通过

## 示例

```typescript
// 1. 契约
interface Summary { title: string; points: string[]; }

// 2. 验证
function validate(output: unknown): output is Summary {
  const s = output as Summary;
  return typeof s.title === 'string' && Array.isArray(s.points);
}

// 3. 执行 prompt → 验证 → 迭代
```

## 优势

- 将 AI 输出的不确定性转化为可验证的测试
- 避免"看起来对但格式不对"的情况
- 多 Agent TDD 中确保接口契约一致性
