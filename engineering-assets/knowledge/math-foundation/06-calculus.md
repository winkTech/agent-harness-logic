---
name: math-foundation/06-calculus
description: 微积分 — 导数、偏导数、微分、积分、基本定理
metadata:
  source: Book3《数学要素》Ch15-18
  type: reference
---

# 微积分

## 导数 (Derivative)

### 定义
f'(x) = lim_{h→0} [f(x+h) - f(x)] / h

几何意义：切线的斜率；物理意义：瞬时变化率。

### 基本导数公式
| f(x) | f'(x) |
|------|-------|
| C (常数) | 0 |
| xⁿ | nxⁿ⁻¹ |
| eˣ | eˣ |
| ln(x) | 1/x |
| sin(x) | cos(x) |
| cos(x) | -sin(x) |
| tan(x) | sec²(x) |
| aˣ | aˣ·ln(a) |
| logₐ(x) | 1/(x·ln(a)) |

### 运算法则
- **(Cf)' = Cf'**（常数倍）
- **(f±g)' = f'±g'**（加减）
- **(fg)' = f'g+fg'**（乘法法则 Leibniz 法则）
- **(f/g)' = (f'g-fg')/g²**（除法法则）
- **链式法则**: (f(g(x)))' = f'(g(x))·g'(x)

### 应用
- 极值: f'(x)=0（临界点）→ 一阶导数变号判断极值
- 凹凸性: f''(x)>0 凹向上（凸函数），f''(x)<0 凹向下
- 拐点: f''(x)=0 且两侧变号
- **L'Hôpital 法则**: lim f/g = lim f'/g'（0/0 或 ∞/∞）

## 偏导数 (Partial Derivative)
- 多元函数 f(x₁, x₂, ..., xₙ) 对 xᵢ 的偏导: ∂f/∂xᵢ
- 保持其他变量不变，对单个变量求导
- **梯度**: ∇f = (∂f/∂x₁, ∂f/∂x₂, ..., ∂f/∂xₙ)
- **Hessian 矩阵**: Hᵢⱼ = ∂²f/∂xᵢ∂xⱼ

## 积分 (Integral)

### 不定积分
∫f(x)dx = F(x) + C，其中 F'(x) = f(x)

### 基本积分公式
| ∫f(x)dx | F(x) |
|---------|------|
| ∫xⁿdx | xⁿ⁺¹/(n+1) + C (n≠-1) |
| ∫1/x dx | ln|x| + C |
| ∫eˣdx | eˣ + C |
| ∫sin(x)dx | -cos(x) + C |
| ∫cos(x)dx | sin(x) + C |
| ∫1/(1+x²)dx | arctan(x) + C |
| ∫1/√(1-x²)dx | arcsin(x) + C |

### 定积分
∫ₐᵇ f(x)dx = F(b) - F(a)（Newton-Leibniz 公式）

### 积分技巧
- **分部积分**: ∫udv = uv - ∫vdu
- **换元积分**: ∫f(g(x))g'(x)dx = ∫f(u)du（u = g(x)）
- **有理函数积分**: 部分分式分解

### 多重积分
- 二重积分: ∬_D f(x,y)dA，体积
- 三重积分: ∭_V f(x,y,z)dV

## 微分中值定理
- **Rolle 定理**: f(a)=f(b) ⇒ ∃c∈(a,b), f'(c)=0
- **Lagrange 中值**: ∃c∈(a,b), f'(c)=[f(b)-f(a)]/(b-a)
- **Taylor 展开**: f(x) = ∑f⁽ⁿ⁾(a)(x-a)ⁿ/n! + Rₙ
