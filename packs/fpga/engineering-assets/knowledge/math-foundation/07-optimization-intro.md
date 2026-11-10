---
name: math-foundation/07-optimization-intro
description: 优化入门 — 无约束优化、梯度下降、约束优化、拉格朗日乘子法
metadata:
  source: Book3《数学要素》Ch19
  type: reference
---

# 优化入门

## 优化问题形式
min f(x), s.t. x ∈ X

- **无约束**: X = ℝⁿ
- **约束**: 等式约束 gᵢ(x)=0，不等式约束 hⱼ(x)≤0

## 无约束优化
必要条件（一阶条件）: ∇f(x*) = 0
充分条件: Hessian 正定 → 局部极小

### 梯度下降法
x_{k+1} = x_k - α∇f(x_k)
- α 为学习率/步长
- 沿负梯度方向迭代，收敛到（局部）极小值
- **变体**: SGD、Adam、AdaGrad（常用在 ML/DL）

## 拉格朗日乘子法
用于等式约束优化：
min f(x), s.t. g(x) = 0

**Lagrangian**: ℒ(x, λ) = f(x) + λg(x)
一阶条件: ∇ℒ = 0 ⇒ ∇f = -λ∇g 且 g(x) = 0

### 多约束
ℒ(x, λ) = f(x) + ∑λᵢgᵢ(x)

## KKT 条件（不等式约束）
对 min f(x), s.t. gᵢ(x) ≤ 0:
1. ∇f + ∑μᵢ∇gᵢ = 0
2. gᵢ(x) ≤ 0（原始可行）
3. μᵢ ≥ 0（对偶可行）
4. μᵢgᵢ(x) = 0（互补松弛）

> **详见 Book4 Ch18** 以矩阵视角深入拉格朗日乘子法。
