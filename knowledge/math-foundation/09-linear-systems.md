---
name: math-foundation/09-linear-systems
description: 线性方程组 — 消元法、代入法、矩阵解法、Cramer 法则
metadata:
  source: Book3《数学要素》Ch23-25（鸡兔同笼）
  type: reference
---

# 线性方程组

## 基本方法

### 消元法（Gauss 消元）
通过倍加、倍乘、交换等行变换，将增广矩阵化为行阶梯形，然后回代求解。

### 代入法
一个方程解出一个变量，代入其他方程。

## 矩阵解法
对 Ax = b：
- A 可逆时: x = A⁻¹b
- Cramer 法则: xᵢ = det(Aᵢ)/det(A)，其中 Aᵢ 是 A 的第 i 列替换为 b

## 解的存在性
- **唯一解**: rank(A) = rank([A|b]) = n
- **无穷多解**: rank(A) = rank([A|b]) < n
- **无解**: rank(A) < rank([A|b])

## 应用视角
- **最小二乘解**: x = (AᵀA)⁻¹Aᵀb（超定方程组，m > n）
- **欠定系统**: 有无数解，可用 norm 最小的解

> 详见 [[linear-algebra/matrix-operations]] 以矩阵视角深入。
