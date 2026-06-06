---
name: python-basics/ch24-pandas-timeseries
description: Pandas 时间序列 — 日期范围、重采样、滚动窗口、时区
metadata:
  source: Book1《编程不难》Ch24
  type: reference
---

# Pandas 时间序列

## 创建日期索引
```python
pd.date_range('2024-01-01', periods=10, freq='D')
# → DatetimeIndex(['2024-01-01', ..., '2024-01-10'], freq='D')

pd.date_range('2024-01', '2024-12', freq='MS')  # 月初
pd.date_range('2024', '2025', freq='Q')          # 季度初
pd.date_range('2024', '2025', freq='B')          # 工作日
```

## 设置时间索引
```python
df['date'] = pd.to_datetime(df['date'])
df = df.set_index('date')
# 或
df = pd.read_csv('data.csv', parse_dates=['date'], index_col='date')
```

## 索引与切片
```python
df['2024']                          # 2024年所有数据
df['2024-01':'2024-03']             # 范围切片
df['2024-01-01':'2024-01-07']       # 日期范围
df.loc['2024-01-01']                # 指定日期
df.between_time('09:00', '17:00')   # 特定时间段
```

## 重采样 (Resample)
```python
# 降采样：高频→低频
df.resample('M').mean()          # 月均值
df.resample('Q').sum()           # 季度求和
df.resample('Y').ohlc()          # 年 OHLC（金融常用）

# 升采样：低频→高频
df.resample('D').ffill()         # 向前填充
df.resample('D').interpolate()   # 插值
```

## 滚动窗口
```python
df['rolling_avg'] = df['value'].rolling(window=7).mean()
df['rolling_std'] = df['value'].rolling(window=20).std()
df['expanding'] = df['value'].expanding().mean()  # 扩展窗口
```

## 时移与差分
```python
df['lag_1'] = df['value'].shift(1)      # 滞后一期
df['diff'] = df['value'].diff()         # 一阶差分
df['pct_change'] = df['value'].pct_change()  # 收益率
df['cumsum'] = df['value'].cumsum()     # 累计和
```

## 时区
```python
df.tz_localize('UTC')                    # 设置时区
df.tz_convert('Asia/Shanghai')           # 转换时区
```

## 金融高频数据特别处理
```python
# 处理非完整交易日
df.resample('B').last()       # 只取交易日
df.resample('W-FRI').last()   # 按周五收盘
```
