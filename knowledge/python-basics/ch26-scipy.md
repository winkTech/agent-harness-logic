---
name: python-basics/ch26-scipy
description: SciPy 科学计算 — 优化、插值、统计、信号处理
metadata:
  source: Book1《编程不难》Ch26
  type: reference
---

# SciPy 科学计算

## 优化 (scipy.optimize)
```python
from scipy.optimize import minimize, curve_fit

# 函数最小化
def f(x):
    return (x[0]-1)**2 + (x[1]-2.5)**2

res = minimize(f, x0=[0, 0])
res.x  # → [1.0, 2.5]

# 曲线拟合
def model(x, a, b, c):
    return a * np.exp(-b * x) + c

xdata = np.linspace(0, 4, 50)
ydata = model(xdata, 2.5, 1.3, 0.5) + 0.2*np.random.randn(50)
popt, _ = curve_fit(model, xdata, ydata)
# popt ≈ [2.5, 1.3, 0.5]
```

## 插值 (scipy.interpolate)
```python
from scipy.interpolate import interp1d, CubicSpline
from scipy.interpolate import griddata

f_linear = interp1d(x, y, kind='linear')
f_cubic = CubicSpline(x, y)  # 三次样条

x_new = np.linspace(x.min(), x.max(), 100)
y_new = f_cubic(x_new)
```

## 统计 (scipy.stats)
```python
from scipy import stats

# 概率分布
data = stats.norm.rvs(size=1000, loc=0, scale=1)     # 采样
pdf = stats.norm.pdf(x, loc=0, scale=1)               # PDF
cdf = stats.norm.cdf(x, loc=0, scale=1)               # CDF
ppf = stats.norm.ppf(0.975)  # 分位点 → 约 1.96

# 统计检验
t_stat, p_val = stats.ttest_ind(group1, group2)   # t 检验
stat, p_val = stats.ks_2samp(sample1, sample2)     # KS 检验
stat, p_val = stats.shapiro(data)                  # 正态性检验
```

## 信号处理 (scipy.signal)
```python
from scipy import signal

# 滤波
b, a = signal.butter(4, 0.1, 'low')           # 巴特沃斯低通
y = signal.filtfilt(b, a, data)               # 零相位滤波

# 卷积
result = signal.convolve(signal1, signal2)

# 频谱
f, Pxx = signal.periodogram(data, fs=1000)    # 功率谱密度
```

## 线性代数 (scipy.linalg)
```python
from scipy import linalg

linalg.inv(A)        # 逆矩阵（比 np.linalg.inv 更全）
linalg.det(A)        # 行列式
linalg.eig(A)        # 特征值
linalg.svd(A)        # SVD
linalg.cholesky(A)   # Cholesky 分解
linalg.qr(A)         # QR 分解
linalg.schur(A)      # Schur 分解
```
> SciPy 的 linalg 比 NumPy 的 linalg 更完整，支持更多矩阵分解算法。
