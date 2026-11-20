---
name: python-basics/ch27-statsmodels
description: Statsmodels 统计建模 — 线性回归、GLM、时间序列 ARIMA、诊断
metadata:
  source: Book1《编程不难》Ch27
  type: reference
---

# Statsmodels 统计模型

## 线性回归
```python
import statsmodels.api as sm

# 添加截距
X = sm.add_constant(X)

# OLS 回归
model = sm.OLS(y, X)
results = model.fit()

results.summary()      # 完整回归结果表
results.params         # 系数
results.pvalues        # p 值
results.rsquared       # R²
results.resid          # 残差
results.fittedvalues   # 拟合值
results.conf_int()     # 系数置信区间
```

## 广义线性模型 (GLM)
```python
# Logistic 回归
logit_model = sm.Logit(y_binary, X)
logit_results = logit_model.fit()
logit_results.summary()

# Poisson 回归（计数数据）
poisson_model = sm.Poisson(y_counts, X)
poisson_results = poisson_model.fit()
```

## 时间序列 ARIMA
```python
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.graphics.tsaplots import plot_acf, plot_pacf

# 平稳性检验
from statsmodels.tsa.stattools import adfuller
adf_stat, p_value = adfuller(series)
# p < 0.05 → 序列平稳

# ACF/PACF 定阶
plot_acf(series)     # 确定 MA 阶数
plot_pacf(series)    # 确定 AR 阶数

# ARIMA 模型
model = ARIMA(series, order=(p, d, q))
results = model.fit()
results.summary()
results.forecast(steps=10)     # 预测
results.resid                  # 残差
```

## 诊断与检验
```python
# 残差正态性
sm.qqline(results.resid, line='s')

# 异方差检验
sm.stats.het_breuschpagan(results.resid, X)

# 自相关检验
sm.stats.durbin_watson(results.resid)
# DW ≈ 2 → 无自相关

# 方差膨胀因子（多重共线性）
from statsmodels.stats.outliers_influence import variance_inflation_factor
vif = [variance_inflation_factor(X, i) for i in range(X.shape[1])]
# VIF > 10 → 严重共线性
```
> **对比**：Statsmodels 重视统计推断（p 值、置信区间、诊断），scikit-learn 重视预测精度。统计学习用 statsmodels，机器学习用 sklearn。
