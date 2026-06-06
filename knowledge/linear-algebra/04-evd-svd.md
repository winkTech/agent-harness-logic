---
name: linear-algebra/04-evd-svd
description: 特征值分解与奇异值分解 — 理论、计算、应用
metadata:
  source: Book4 Ch11-16 + LA
  type: reference
---

# 特征值分解 (EVD) 与奇异值分解 (SVD)

## 特征值分解

**定义**: Av = λv，λ 是特征值，v 是特征向量。
- n×n 矩阵 A 可分解为: A = VΛV⁻¹
- V 的列 = 特征向量，Λ = diag(λ₁, ..., λₙ)

### 实对称矩阵的特殊性质
- 特征值全为实数
- 特征向量正交: A = QΛQᵀ (Q 正交矩阵)
- 正定 ⇔ 所有特征值 > 0

## 奇异值分解 (SVD)

对任意矩阵 A ∈ ℝ^{m×n}:
**A = UΣVᵀ**

- U: m×m 正交矩阵，左奇异向量（AAᵀ 的特征向量）
- Σ: m×n 对角矩阵，奇异值 σ₁≥σ₂≥...≥σᵣ>0
- V: n×n 正交矩阵，右奇异向量（AᵀA 的特征向量）

```python
A = np.random.randn(5, 3)
U, s, Vt = np.linalg.svd(A, full_matrices=False)
# s = [σ₁, σ₂, σ₃]

# 重建
A_reconstructed = U @ np.diag(s) @ Vt
```

## 四大基础子空间与 SVD

| 子空间 | 基(U/SVD) | 维度 |
|--------|-----------|------|
| 列空间 C(A) | U 的前 r 列 | r |
| 行空间 C(Aᵀ) | V 的前 r 列 | r |
| 零空间 N(A) | V 的后 n-r 列 | n-r |
| 左零空间 N(Aᵀ) | U 的后 m-r 列 | m-r |
> r = rank(A)

## 关键应用

### 1. 伪逆 (Pseudoinverse)
A⁺ = VΣ⁺Uᵀ（Σ⁺: 非零奇异值取倒数）
```python
np.linalg.pinv(A)  # Moore-Penrose 伪逆
```

### 2. 低秩近似（截断 SVD）
Aₖ = UₖΣₖVₖᵀ（保留前 k 个奇异值）
```python
from sklearn.decomposition import TruncatedSVD
svd = TruncatedSVD(n_components=2)
A_reduced = svd.fit_transform(A)
```

### 3. PCA
```python
from sklearn.decomposition import PCA
pca = PCA(n_components=2)
X_pca = pca.fit_transform(X)
# 等价于对中心化数据做 SVD
```

### 4. 条件数
cond(A) = σ₁/σᵣ（最大奇异值/最小）
- 大条件数 → 病态矩阵，解对误差敏感

## EVD vs SVD
| 特性 | EVD | SVD |
|------|-----|-----|
| 适用 | 方阵（可对角化） | 任意矩阵 |
| 分解 | A = VΛV⁻¹ | A = UΣVᵀ |
| 向量 | 特征向量不正交 | 左右奇异向量正交 |
| 主成分 | 对称矩阵的谱分解 | PCA 的理论基础 |
