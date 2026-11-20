---
name: python-basics/ch13-numpy-basics
description: NumPy 基础 — 创建数组、数据类型、基本操作
metadata:
  source: Book1《编程不难》Ch13
  type: reference
---

# NumPy 基础

## 创建数组
```python
import numpy as np

np.array([1, 2, 3])              # 从列表创建
np.array((1, 2, 3))              # 从元组创建
np.zeros((3, 4))                 # 全零矩阵
np.ones((2, 3))                  # 全一矩阵
np.eye(3)                        # 单位矩阵
np.full((2,2), 7)                # 填充常数
np.arange(10)                    # 类似 range → [0...9]
np.linspace(0, 1, 5)             # 等间距 → [0, 0.25, 0.5, 0.75, 1]
np.random.rand(3, 3)             # [0,1) 均匀分布
np.random.randn(3, 3)            # 标准正态分布
np.random.randint(0, 10, (3,3))  # 随机整数
```

## 数组属性
```python
a = np.array([[1,2,3],[4,5,6]])

a.shape      # → (2, 3)  形状
a.ndim       # → 2       维度数
a.size       # → 6       元素总数
a.dtype      # → int64   数据类型
a.T          # → 转置
```

## 数据类型
```python
np.array([1,2], dtype=np.float32)  # 指定类型
np.int8, np.int16, np.int32, np.int64
np.float16, np.float32, np.float64
np.complex64, np.complex128
```

## 基本操作
```python
a + 1         # 广播加法
a * 2         # 标量乘法
a + b         # 对应元素相加
a * b         # 对应元素相乘（Hadamard积）
a @ b         # 矩阵乘法（推荐）
np.dot(a, b)  # 矩阵乘法
a.sum()       # 所有元素和
a.mean()      # 均值
a.std()       # 标准差
a.min()       # 最小值
a.max()       # 最大值
a.argmax()    # 最大值索引
```

## 形状操作
```python
a.reshape(3, 2)    # 重塑形状
a.flatten()        # 展平为一维
a.ravel()          # 展平（可能返回视图）
np.concatenate([a, b])   # 拼接
np.vstack([a, b])        # 垂直堆叠
np.hstack([a, b])        # 水平堆叠
```

## 数学函数
```python
np.sqrt(a)
np.sin(a), np.cos(a), np.tan(a)
np.exp(a), np.log(a), np.log10(a)
np.abs(a), np.sign(a)
np.round(a, 2)
```
