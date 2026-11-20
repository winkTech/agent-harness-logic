---
name: probability-statistics/03-statistical-inference
description: 统计推断 — 点估计、置信区间、假设检验、回归分析
metadata:
  source: Book4 Ch22 + Book3 Ch21 综合
  type: reference
---

# 统计推断

## 点估计
- **矩估计**: 用样本矩估计总体矩
- **MLE (最大似然估计)**: 最大化似然函数 L(θ|x)
- **无偏性**: E[θ̂] = θ
- **一致性**: θ̂ → θ (n→∞)

## 置信区间
- **均值 μ 的 CI**: x̄ ± t_{α/2}(n-1) · s/√n
- **比例 p 的 CI**: p̂ ± z_{α/2}·√(p̂(1-p̂)/n)
- 含义: 在 100(1-α)% 的置信水平下，重复抽样中该区间包含真值的比例

## 假设检验

### 框架
1. 建立 H₀（原假设）和 H₁（备择假设）
2. 选择检验统计量
3. 确定显著性水平 α
4. 计算 p 值或拒绝域
5. p < α → 拒绝 H₀

### 常用检验
| 检验 | 用途 | Python |
|------|------|--------|
| t 检验 | 均值比较 | `ttest_ind(a, b)` |
| 配对 t 检验 | 配对数据 | `ttest_rel(before, after)` |
| 单样本 t 检验 | 均值 vs 常数 | `ttest_1samp(data, μ)` |
| χ² 检验 | 分类变量独立性 | `chi2_contingency(table)` |
| F 检验 (ANOVA) | 多组均值比较 | `f_oneway(g1, g2, g3)` |
| KS 检验 | 分布一致性 | `ks_2samp(sample1, sample2)` |
| Shapiro-Wilk | 正态性检验 | `shapiro(data)` |

```python
from scipy.stats import ttest_ind

t_stat, p_value = ttest_ind(group1, group2)
# p < 0.05 → 两组均值有显著差异
```

### 两类错误
- **Type I (α)**: 拒绝真 H₀（假阳性）
- **Type II (β)**: 接受假 H₀（假阴性）
- **功效 (Power)**: 1-β，正确拒绝假 H₀ 的概率

## 方差分析 (ANOVA)
比较三个及以上组均值是否相等：
F = 组间方差 / 组内方差

## 回归分析
- **简单线性**: y = β₀ + β₁x + ε
- **多元线性**: y = Xβ + ε
- **决定系数 R²**: 模型解释的方差比例
- **调整 R²**: 惩罚变量个数
- **F 检验**: 整体显著性
- **t 检验**: 各系数显著性
