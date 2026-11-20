---
name: probability-statistics/02-random-variables
description: 随机变量与分布 — 离散/连续、期望、方差、常用分布
metadata:
  source: Prob&Stat Ch05-07 及扩展
  type: reference
---

# 随机变量与分布

## 离散随机变量
取值为可数多个，由 **概率质量函数 (PMF)** P(X=x) 描述。

### 伯努利分布 Bernoulli(p)
- X ∈ {0,1}, P(X=1) = p
- E[X] = p, Var(X) = p(1-p)
- 应用: 单次试验成功/失败

### 二项分布 Binomial(n, p)
- X = ∑Bernoulli(p) 的和（n 次独立试验）
- P(X=k) = C(n,k) pᵏ(1-p)^{n-k}
- E[X] = np, Var(X) = np(1-p)
- n=1 时退化为 Bernoulli

### 泊松分布 Poisson(λ)
- P(X=k) = λᵏe^{-λ}/k!
- E[X] = λ = Var(X)
- 应用: 单位时间内事件发生的次数（稀有事件）
- 二项分布的极限 (n→∞, p→0, np→λ)

```python
from scipy.stats import binom, poisson

binom.pmf(k, n, p)   # PMF
binom.cdf(k, n, p)   # CDF
poisson.pmf(k, mu=λ)
poisson.rvs(mu=λ, size=1000)  # 采样
```

## 连续随机变量
取值为连续区间，由 **概率密度函数 (PDF)** f(x) 描述。
P(a<X<b) = ∫ₐᵇ f(x)dx

### 正态分布 N(μ, σ²)
- f(x) = 1/(σ√(2π)) · exp(-(x-μ)²/(2σ²))
- E[X] = μ, Var(X) = σ²
- **标准正态**: Z ~ N(0,1)
- 标准化: Z = (X-μ)/σ
- **68-95-99.7 法则**: ±1σ=68%, ±2σ=95%, ±3σ=99.7%

### 均匀分布 Uniform(a,b)
- f(x) = 1/(b-a), x ∈ [a,b]
- E[X] = (a+b)/2, Var(X) = (b-a)²/12

### 指数分布 Exp(λ)
- f(x) = λe^{-λx}, x ≥ 0
- E[X] = 1/λ, Var(X) = 1/λ²
- **无记忆性**: P(X > s+t | X > s) = P(X > t)

### 其他常用分布
| 分布 | 参数 | 应用 |
|------|------|------|
| t 分布 | 自由度 ν | 小样本均值推断 |
| χ² 分布 | 自由度 ν | 方差检验、拟合优度 |
| F 分布 | ν₁, ν₂ | 方差分析 (ANOVA) |
| Beta | α, β | 先验分布（贝叶斯） |
| Gamma | k, θ | 等待时间 |

```python
from scipy.stats import norm
norm.pdf(x, loc=μ, scale=σ)  # PDF
norm.cdf(x, loc=μ, scale=σ)  # CDF
norm.ppf(p, loc=μ, scale=σ)  # 分位点
norm.rvs(loc=μ, scale=σ, size=100)  # 采样
```

## 期望与方差
- E[X] = ∑x·P(X=x)（离散）= ∫x·f(x)dx（连续）
- E[aX+b] = aE[X]+b
- Var(X) = E[(X-μ)²] = E[X²] - (E[X])²
- Var(aX+b) = a²Var(X)
- **标准差**: σ = √Var(X)

### 协方差与相关系数
- Cov(X,Y) = E[(X-μₓ)(Y-μᵧ)] = E[XY] - E[X]E[Y]
- ρ = Cov(X,Y)/(σₓσᵧ) ∈ [-1,1]
- ρ = 0: 不相关（不一定独立）
- ρ > 0: 正相关，ρ < 0: 负相关

## 大数定律与中心极限定理
- **大数定律**: 样本均值 → 总体均值（n→∞）
- **CLT**: 样本均值的分布趋近正态分布 N(μ, σ²/n)，n 足够大时
