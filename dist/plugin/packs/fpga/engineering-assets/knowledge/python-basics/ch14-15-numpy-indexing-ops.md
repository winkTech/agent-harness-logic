---
name: python-basics/ch14-15-numpy-indexing
description: NumPy 索引、切片、运算 — 花式索引、广播、ufunc
metadata:
  source: Book1《编程不难》Ch14-15
  type: reference
---

# NumPy 索引与运算

## 索引与切片
```python
a = np.array([[1,2,3],[4,5,6],[7,8,9]])

a[0]           # 第一行     → [1,2,3]
a[0, 1]        # 第0行第1列 → 2
a[:2]          # 前两行
a[:, 1:]       # 所有行的第1列之后
a[::2]         # 步长为2
a[::-1]        # 反转行顺序
```

### 花式索引 (Fancy Indexing)
```python
a[[0, 2]]      # 选取第0和第2行
a[:, [0, 2]]   # 选取第0和第2列
a[a > 5]       # 布尔索引：选取所有大于5的元素
```

## 广播 (Broadcasting)
```python
a = np.array([[1,2,3],[4,5,6]])  # shape (2,3)
b = np.array([10,20,30])         # shape (3,)

a + b  # 广播：b 沿行方向自动扩展
# → [[11,22,33],[14,25,36]]
```
**广播规则**：从尾部维度开始比较，维度为1或缺失时自动扩展。

## ufunc (通用函数)
```python
np.add(a, b)    # +
np.subtract(a,b)# -
np.multiply(a,b)# *
np.divide(a,b)  # /
np.power(a, 2)  # **
np.mod(a, 2)    # %
np.greater(a, 5)# 比较

# 聚合
np.add.reduce(a)    # 沿轴求和（同 a.sum()）
np.add.accumulate(a)# 累积和
np.add.outer(a, b)  # 外积
```

## 统计运算
```python
np.sum(a, axis=0)     # 沿列求和
np.mean(a, axis=1)    # 沿行求均值
np.median(a)
np.percentile(a, 75)  # 第75百分位数
np.corrcoef(a)        # 相关系数矩阵
np.cov(a)             # 协方差矩阵
```

## 线性代数（numpy.linalg）
```python
np.linalg.det(a)      # 行列式
np.linalg.inv(a)      # 逆矩阵
np.linalg.eig(a)      # 特征值/特征向量
np.linalg.svd(a)      # 奇异值分解
np.linalg.qr(a)       # QR 分解
np.linalg.norm(a)     # 范数
np.linalg.solve(A, b) # 解线性方程组 Ax=b
```
