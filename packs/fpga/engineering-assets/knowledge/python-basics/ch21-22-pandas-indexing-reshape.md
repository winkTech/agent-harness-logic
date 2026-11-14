---
name: python-basics/ch21-22-pandas-indexing-reshape
description: Pandas 索引、切片、数据规整 — loc/iloc、groupby、melt、pivot
metadata:
  source: Book1《编程不难》Ch21-22
  type: reference
---

# Pandas 索引与规整

## 索引与选择
```python
# 基于标签的索引
df.loc[0]             # 按行标签选一行
df.loc[0:5]           # 行切片（含末尾）
df.loc[0:5, ['a','b']]# 行+列切片
df.loc[df['age']>18]  # 条件筛选

# 基于位置的索引
df.iloc[0]            # 第0行
df.iloc[0:3, 0:2]     # 前3行×前2列

# 条件筛选
df[df['col'] > 10]
df[(df['a'] > 0) & (df['b'] < 5)]
df.query('a > 0 and b < 5')  # 字符串表达式（推荐）
```

## 聚合: groupby
```python
df.groupby('category').mean()          # 分组求均值
df.groupby('category').agg({
    'price': 'mean',
    'qty': 'sum',
    'name': 'count'
})                                     # 不同列不同聚合
df.groupby(['cat1', 'cat2']).size()    # 多级分组计数
```

## 数据整形: melt / pivot / stack
```python
# 宽表→长表（melt）
pd.melt(df, id_vars=['id'], value_vars=['a','b','c'])

# 长表→宽表（pivot）
df.pivot(index='date', columns='variable', values='value')

# 堆叠/取消堆叠
df.stack()    # 列→行（变窄变长）
df.unstack()  # 行→列（变宽变短）
```

## 合并: merge / join / concat
```python
# SQL 风格合并
pd.merge(df1, df2, on='key')              # INNER JOIN
pd.merge(df1, df2, on='key', how='left')  # LEFT JOIN
pd.merge(df1, df2, on=['k1','k2'])        # 多键合并

# 索引连接
df1.join(df2, lsuffix='_l', rsuffix='_r')

# 简单拼接
pd.concat([df1, df2])        # 纵向堆叠
pd.concat([df1, df2], axis=1)# 横向拼接
```

## 常用数据清洗
```python
df.drop_duplicates()               # 去重
df.duplicated().sum()              # 重复行数
df['col'].str.strip()              # 去除字符串空格
df['col'].str.lower()              # 转小写
df['col'].str.contains('pattern')  # 字符串匹配
df['date'] = pd.to_datetime(df['date'])  # 日期转换
df.sort_values('col', ascending=False)   # 排序
df.reset_index(drop=True)                # 重置索引
df.set_index('col')                      # 设置索引
```
