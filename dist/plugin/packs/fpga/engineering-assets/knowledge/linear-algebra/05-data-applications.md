---
name: linear-algebra/05-data-applications
description: 矩阵在数据科学中的应用 — 数据矩阵、协方差、PCA、线性回归、图矩阵
metadata:
  source: Book4 Ch22-25 + LA
  type: reference
---

# 矩阵在数据科学中的应用

## 数据矩阵
X ∈ ℝ^{n×p}：n 个样本，p 个特征

```python
# 中心化
X_centered = X - X.mean(axis=0)

# 标准化
X_scaled = (X - X.mean(axis=0)) / X.std(axis=0)
# 或直接用 StandardScaler
```

## 协方差矩阵
S = (1/(n-1))XᵀX（中心化后）
- 对角元: 各特征的方差
- 非对角元: 特征间协方差
- 特征值分解揭示数据的主成分方向

## PCA 推导（SVD 视角）
1. 中心化数据 X
2. SVD: X = UΣVᵀ
3. 主成分方向: V 的列（右奇异向量）
4. 主成分得分: XV = UΣ
5. 方差解释率: σᵢ²/∑σⱼ²

## 线性回归（矩阵形式）
y = Xβ + ε，最小二乘解: β̂ = (XᵀX)⁻¹Xᵀy

- 投影矩阵: H = X(XᵀX)⁻¹Xᵀ
- 拟合值: ŷ = Hy
- 残差: e = y - ŷ = (I-H)y

## 图与拉普拉斯矩阵
- 无向图: A 邻接矩阵，D 度矩阵
- 拉普拉斯: L = D - A
- 性质: L 对称半正定，特征值 0 出现次数=连通分量数
- 谱聚类: 用 L 的前 k 个特征向量聚类

```python
# 图的例子：PageRank
# 转移矩阵 P（列随机矩阵）
# 稳态向量 π = Pπ（特征值 1 的特征向量）
```
