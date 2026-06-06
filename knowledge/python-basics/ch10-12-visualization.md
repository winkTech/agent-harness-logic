---
name: python-basics/ch10-12-visualization
description: Python 可视化 — Matplotlib、Seaborn、Plotly 基础
metadata:
  source: Book1《编程不难》Ch10-12, Ch23
  type: reference
---

# Python 可视化

## Matplotlib 基础
```python
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 10, 100)

# 线图
plt.figure(figsize=(8, 5))
plt.plot(x, np.sin(x), label='sin(x)', linewidth=2)
plt.plot(x, np.cos(x), label='cos(x)', linestyle='--')
plt.xlabel('x')
plt.ylabel('y')
plt.title('Sine and Cosine')
plt.legend()
plt.grid(True, alpha=0.3)
plt.show()

# 子图
fig, axes = plt.subplots(2, 2, figsize=(10, 8))
axes[0,0].plot(x, np.sin(x))
axes[0,1].plot(x, np.cos(x))
```

## Seaborn 统计可视化
```python
import seaborn as sns
sns.set_theme(style='whitegrid')

# 分布图
sns.histplot(df['col'], kde=True)
sns.kdeplot(df['col'])

# 关系图
sns.scatterplot(data=df, x='col1', y='col2', hue='category')
sns.pairplot(df, hue='target')        # 多变量矩阵
sns.heatmap(df.corr(), annot=True)     # 热力图

# 分类图
sns.boxplot(data=df, x='cat', y='value')
sns.violinplot(data=df, x='cat', y='value')
sns.barplot(data=df, x='cat', y='value')

# 回归图
sns.regplot(data=df, x='x', y='y')    # 散点+线性回归线
sns.lmplot(data=df, x='x', y='y', hue='cat')  # 分面回归
```

## Plotly 交互式可视化
```python
import plotly.express as px
import plotly.graph_objects as go

# express API（简洁）
fig = px.scatter(df, x='col1', y='col2', color='cat',
                 size='value', hover_data=['col3'])
fig = px.line(df, x='date', y='value')
fig = px.histogram(df, x='col')

# graph_objects API（灵活）
fig = go.Figure()
fig.add_trace(go.Scatter(x=x, y=y, mode='lines+markers'))
fig.update_layout(title='Title', xaxis_title='X', yaxis_title='Y')
fig.show()
```

## 可视化选择指南
| 需求 | 推荐 | 说明 |
|------|------|------|
| 快速探索 | Seaborn `sns.*` | 默认美观，语法简洁 |
| 出版级静态图 | Matplotlib | 完全可控，调整一切 |
| 交互式/Web | Plotly | 悬停提示、缩放、保存 HTML |
| 大数据量 | `sns.kdeplot` / `plt.hexbin` | 避免散点图重叠 |
| 地理数据 | plotly.express + mapbox | 内置地图支持 |
