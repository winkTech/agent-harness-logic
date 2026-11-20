---
name: linear-algebra/01-vector-basics
description: 向量基础 — 定义、运算、线性组合、内积、范数、正交
metadata:
  source: LA Ch01-08 + Book4 Ch01-03
  type: reference
---

# 向量基础

## 向量定义
- **向量**: 既有大小又有方向的量，记作 v = [v₁, v₂, ..., vₙ]ᵀ
- **行向量**: [1, 2, 3]
- **列向量**: [1, 2, 3]ᵀ
- **零向量**: 所有分量为 0
- **单位向量**: ‖v‖ = 1

## 向量运算
```python
import numpy as np

a = np.array([1, 2, 3])
b = np.array([4, 5, 6])

a + b           # 加法: [5, 7, 9]
2 * a           # 标量乘法: [2, 4, 6]
np.dot(a, b)    # 内积(点积): 1*4+2*5+3*6 = 32
np.cross(a, b)  # 叉积(3D): [-3, 6, -3]
np.linalg.norm(a)  # L2 范数: √(1+4+9)
```

## 内积 (Dot Product)
a · b = ‖a‖‖b‖·cos(θ) = ∑aᵢbᵢ

- 正交: a · b = 0 ⇔ cos(θ)=0 ⇔ θ=90°
- 平行: |a · b| = ‖a‖‖b‖
- 投影: proj_b(a) = ((a·b)/(‖b‖²))b

## 范数 (Norm)
| 范数 | 公式 | 用途 |
|------|------|------|
| L1 | ‖x‖₁ = ∑|xᵢ| | 稀疏性、LASSO |
| L2 (Euclidean) | ‖x‖₂ = √(∑xᵢ²) | 最常用，距离 |
| L∞ | ‖x‖∞ = max|xᵢ| | 切比雪夫距离 |
| Lp | (∑\|xᵢ\|ᵖ)^{1/p} | 一般情况 |

## 线性组合与线性无关
- **线性组合**: v = c₁v₁ + c₂v₂ + ... + cₖvₖ
- **线性无关**: c₁v₁+...+cₖvₖ=0 ⇒ 所有 cᵢ=0
- **线性相关**: 存在一组非全零系数使线性组合为零
- **张成 (Span)**: 所有线性组合的集合

## Gram-Schmidt 正交化
将一组线性无关的向量转换为一组正交单位向量：
```python
# 直接用 QR 分解实现
Q, R = np.linalg.qr(A)  # Q 的列即为正交基
```
