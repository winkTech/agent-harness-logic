---
name: linear-algebra/03-vector-space-transform
description: 向量空间与几何变换 — 子空间、基变换、线性变换、正交投影
metadata:
  source: LA + Book4 Ch07-09
  type: reference
---

# 向量空间与几何变换

## 向量空间
ℝⁿ: 对所有向量加法和标量乘法封闭的集合

### 子空间 (Subspace)
- **列空间 (Column space)**: span{列向量}，记作 C(A)
- **零空间 (Null space)**: {x | Ax=0}，记作 N(A)
- **行空间 (Row space)**: span{行向量}，记作 C(Aᵀ)
- **左零空间**: {y | yᵀA=0}
- 维度关系: dim(C(A)) = rank(A)，dim(N(A)) = n - rank(A)

### 基 (Basis)
**基** = 张成该空间的最少线性无关向量组
- 标准基: e₁=[1,0,...]ᵀ, e₂=[0,1,...]ᵀ, ...
- 基变换: 😡_新] = P⁻¹·[x_旧], P 是新基到旧基的坐标变换

## 几何变换（2D）

```python
# 齐次坐标 [x, y, 1]ᵀ
# 平移
T = np.array([[1, 0, tx],
              [0, 1, ty],
              [0, 0, 1]])
# 旋转（θ 弧度）
R = np.array([[np.cos(θ), -np.sin(θ), 0],
              [np.sin(θ),  np.cos(θ), 0],
              [0,          0,         1]])
# 缩放
S = np.array([[sx, 0, 0],
              [0, sy, 0],
              [0, 0, 1]])
# 仿射变换 = 线性变换 + 平移
```

## 正交投影 (Orthogonal Projection)
将向量 v 投影到子空间 W 上：
```python
# 投影到 A 的列空间
P = A @ np.linalg.inv(A.T @ A) @ A.T  # 投影矩阵
proj = P @ v

# 最小二乘解
x_ls = np.linalg.lstsq(A, b, rcond=None)[0]
# 等价于: x = (AᵀA)⁻¹Aᵀb
```

性质: P² = P（幂等），Pᵀ = P（对称）
