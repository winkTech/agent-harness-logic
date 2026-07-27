---
name: python-basics/ch25-sympy
description: SymPy 符号数学 — 符号定义、化简、微积分、方程求解
metadata:
  source: Book1《编程不难》Ch25
  type: reference
---

# SymPy 符号数学

## 符号定义
```python
import sympy as sp

x, y, z = sp.symbols('x y z')
# 或
x = sp.Symbol('x')

# 带假设的符号
n = sp.Symbol('n', integer=True, positive=True)
```

## 代数运算
```python
sp.expand((x + 1)**2)        # 展开 → x² + 2x + 1
sp.factor(x**2 - 1)          # 因式分解 → (x-1)(x+1)
sp.simplify(sp.sin(x)**2 + sp.cos(x)**2)  # 化简 → 1

sp.apart(1/(x-1)/(x+1), x)  # 部分分式分解
sp.together(1/x + 1/(x+1))  # 通分合并
```

## 微积分
```python
# 极限
sp.limit(sp.sin(x)/x, x, 0)  # → 1

# 导数
sp.diff(x**3, x)             # → 3x²
sp.diff(x**2*y, x, y)        # → 2x（混合偏导）

# 积分
sp.integrate(x**2, x)        # → x³/3
sp.integrate(x, (x, 0, 1))   # 定积分 → 1/2
sp.integrate(x*y, (x,0,1), (y,0,2))  # 二重积分

# 级数展开
sp.series(sp.sin(x), x, 0, 5)  # → x - x³/6 + O(x⁵)
```

## 方程求解
```python
# 代数方程
sp.solve(x**2 - 4, x)        # → [-2, 2]

# 方程组
sp.solve([x + y - 1, x - y - 3], [x, y])  # → {x: 2, y: -1}

# 微分方程
f = sp.Function('f')
sp.dsolve(sp.diff(f(x), x) - f(x), f(x))
# → Eq(f(x), C1*exp(x))
```

## 矩阵
```python
A = sp.Matrix([[1, 2], [3, 4]])
A.det()       # → -2
A.inv()       # 逆矩阵
A.eigenvals() # 特征值
A.eigenvects()# 特征向量
```

## LaTeX 输出
```python
sp.latex(sp.Integral(sp.sin(x), x))
# → \int \sin(x)\, dx
```

## 数值求值
```python
sp.N(sp.pi, 50)  # π 到 50 位小数
expr = sp.sqrt(2)
expr.evalf()     # → 1.41421356237310
```
