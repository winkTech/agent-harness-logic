---
name: python-basics/ch19-pandas-intro
description: Pandas 基础 — Series、DataFrame、读写数据、基本操作
metadata:
  source: Book1《编程不难》Ch19
  type: reference
---

# Pandas 基础

## 核心数据结构
```python
import pandas as pd

# Series — 一维带标签数组
s = pd.Series([1, 3, 5, np.nan, 6, 8])
s = pd.Series([1, 2, 3], index=['a', 'b', 'c'])

# DataFrame — 二维表格
df = pd.DataFrame({
    'name': ['Alice', 'Bob', 'Charlie'],
    'age': [25, 30, 35],
    'city': ['NY', 'SF', 'LA']
})
```

## 读写数据
```python
pd.read_csv('file.csv')          # CSV
pd.read_excel('file.xlsx')       # Excel
pd.read_parquet('file.parquet')  # Parquet
pd.read_sql('SELECT * FROM t', conn)  # SQL

df.to_csv('out.csv', index=False)
df.to_excel('out.xlsx', index=False)
```

## 快速查看
```python
df.head(10)       # 前N行
df.tail()         # 后N行
df.info()         # 基本信息（列名、类型、非空数）
df.describe()     # 统计摘要
df.dtypes         # 每列类型
df.columns        # 列名列表
df.index          # 行索引
df.shape          # (行, 列)
df.values         # 底层 NumPy 数组
```

## 列操作
```python
df['new_col'] = df['a'] + df['b']  # 新增列
df['col']                          # 选一列（Series）
df[['a', 'b']]                     # 选多列（DataFrame）
df.drop('col', axis=1)             # 删除列
df.rename(columns={'old': 'new'})  # 重命名
```

## 缺失值处理
```python
df.isna().sum()     # 每列缺失值计数
df.dropna()         # 删除含缺失值的行
df.fillna(0)        # 填充缺失值
df.fillna(method='ffill')  # 向前填充
```

## 常用链式操作
```python
df = (pd.read_csv('data.csv')
      .dropna()
      .query('age > 18')
      .groupby('city')
      .agg({'age': 'mean', 'name': 'count'})
      .reset_index())
```
