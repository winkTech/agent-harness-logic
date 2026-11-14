---
name: python-basics/ch16-18-numpy-advanced
description: NumPy 进阶 — 数组规整、einsum、向量化思维
metadata:
  source: Book1《编程不难》Ch16-18
  type: reference
---

# NumPy 进阶

## 数组规整
```python
# 拼接与分割
np.concatenate([a, b])         # 沿现有轴拼接
np.vstack([a, b])              # 垂直堆叠
np.hstack([a, b])              # 水平堆叠
np.split(a, 3)                 # 均匀分割
np.array_split(a, 3)           # 不均匀分割

# 新增/删除维度
a[np.newaxis, :]               # shape (1, n)
np.expand_dims(a, axis=0)      # 同上
np.squeeze(a)                  # 删除长度1的维度

# 转置与轴交换
a.T                            # 转置
np.swapaxes(a, 0, 1)          # 交换两轴
np.transpose(a, (1, 0))       # 指定轴顺序

# 排序
np.sort(a)                     # 返回排序副本
a.sort()                       # 原地排序
np.argsort(a)                  # 排序后的索引
np.lexsort((col1, col2))       # 多列排序
```

## Einstein 求和约定 (einsum)
```python
# einsum 是用字符串描述张量运算的利器

np.einsum('ij->i', a)          # 行求和（同 a.sum(axis=1)）
np.einsum('ij->j', a)          # 列求和
np.einsum('ij->', a)           # 全部求和
np.einsum('ij->ji', a)         # 转置
np.einsum('ij,jk->ik', A, B)  # 矩阵乘法
np.einsum('ij,ij->', A, B)    # Frobenius 内积
np.einsum('ij,ij->ij', A, B)  # 逐元素相乘
np.einsum('i,i->', a, b)      # 向量点积
np.einsum('i->', a)           # 向量求和
```

> einsum 表示法：`->` 左边是输入张量的维度标签，右边是输出张量的维度标签。消失的维度表示求和（收缩），重复的标签表示匹配的维度。

## 向量化思维（核心原则）
```python
# ❌ 不推荐：Python 显式循环
result = np.zeros(1000)
for i in range(1000):
    result[i] = np.sin(i * 0.01)

# ✅ 推荐：NumPy 向量化
x = np.arange(1000) * 0.01
result = np.sin(x)  # 快 10-100x
```

**向量化优势**：
1. C 语言底层实现，速度远快于 Python 循环
2. 代码更简洁、可读性更强
3. 可利用 SIMD 等 CPU 指令级优化

**实践原则**：
- 用 `np.where(cond, x, y)` 替代 `if/else` 循环
- 用 `np.sum / np.mean / np.dot` 等聚合函数
- 用广播避免显式扩展维度
- 用 `einsum` 简化复杂张量运算
