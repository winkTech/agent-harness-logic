---
name: python-basics/ch30-33-sklearn-models
description: scikit-learn 模型 — 回归、降维、分类、聚类
metadata:
  source: Book1《编程不难》Ch30-33
  type: reference
---

# sklearn 回归、降维、分类、聚类

## 回归 (Regression)
```python
from sklearn.linear_model import LinearRegression, Ridge, Lasso
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_squared_error, r2_score

lr = LinearRegression()
lr.fit(X_train, y_train)
y_pred = lr.predict(X_test)

lr.coef_       # 系数
lr.intercept_  # 截距
mse = mean_squared_error(y_test, y_pred)
r2 = r2_score(y_test, y_pred)

# 正则化回归
Ridge(alpha=1.0)     # L2 正则化
Lasso(alpha=0.1)     # L1 正则化（产生稀疏解）
```

## 降维 (Dimensionality Reduction)
```python
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE

# PCA （主成分分析）
pca = PCA(n_components=2)
X_pca = pca.fit_transform(X_scaled)
pca.explained_variance_ratio_  # 各主成分解释方差比例
pca.components_                # 主成分方向

# t-SNE （可视化降维）
tsne = TSNE(n_components=2, random_state=42)
X_tsne = tsne.fit_transform(X_scaled)
```

## 分类 (Classification)
```python
from sklearn.linear_model import LogisticRegression
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.neighbors import KNeighborsClassifier
from sklearn.naive_bayes import GaussianNB
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score,
    confusion_matrix, classification_report
)

clf = RandomForestClassifier(n_estimators=100, random_state=42)
clf.fit(X_train, y_train)
y_pred = clf.predict(X_test)
y_prob = clf.predict_proba(X_test)  # 概率输出

print(confusion_matrix(y_test, y_pred))
print(classification_report(y_test, y_pred))

# 特征重要性
clf.feature_importances_
```

## 聚类 (Clustering)
```python
from sklearn.cluster import KMeans, DBSCAN, AgglomerativeClustering

# K-Means
kmeans = KMeans(n_clusters=3, random_state=42, n_init=10)
kmeans.fit(X_scaled)
kmeans.labels_           # 聚类标签
kmeans.cluster_centers_  # 聚类中心
kmeans.inertia_          # 簇内平方和（评估聚类质量）

# DBSCAN（密度聚类，无需指定 k）
dbscan = DBSCAN(eps=0.5, min_samples=5)
dbscan.fit(X_scaled)
dbscan.labels_  # -1 表示噪声点

# 层次聚类
agg = AgglomerativeClustering(n_clusters=3)
agg.fit_predict(X_scaled)
```

## 模型保存
```python
import joblib

# 保存
joblib.dump(model, 'model.pkl')

# 加载
model = joblib.load('model.pkl')
model.predict(X_new)
```
