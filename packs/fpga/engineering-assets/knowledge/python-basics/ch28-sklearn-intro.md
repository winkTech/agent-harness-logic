---
name: python-basics/ch28-sklearn-intro
description: scikit-learn 机器学习概览 — API 规范、流水线、数据集
metadata:
  source: Book1《编程不难》Ch28-29
  type: reference
---

# scikit-learn 机器学习

## sklearn API 规范
```python
from sklearn import datasets, model_selection, preprocessing, pipeline
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report

# 1. 加载数据
X, y = datasets.load_iris(return_X_y=True)

# 2. 划分数据
X_train, X_test, y_train, y_test = model_selection.train_test_split(
    X, y, test_size=0.3, random_state=42
)

# 3. 预处理
scaler = preprocessing.StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

# 4. 训练
model = LogisticRegression()
model.fit(X_train_scaled, y_train)

# 5. 预测 & 评估
y_pred = model.predict(X_test_scaled)
print(classification_report(y_test, y_pred))
```

**统一接口**：所有 estimator 都遵循 `fit()` / `predict()` / `transform()`。

## Pipeline（流水线）
```python
from sklearn.pipeline import Pipeline

pipe = Pipeline([
    ('scaler', StandardScaler()),
    ('pca', PCA(n_components=2)),
    ('clf', LogisticRegression())
])

pipe.fit(X_train, y_train)
pipe.score(X_test, y_test)  # 端到端评估
# 或：pipe.predict(X_test)
```
Pipeline 自动确保预处理只从训练集学习参数，防止数据泄露。

## 内置数据集
```python
datasets.load_iris()       # 鸢尾花（分类）
datasets.load_digits()     # 手写数字（分类）
datasets.load_wine()       # 葡萄酒（分类）
datasets.load_breast_cancer()  # 乳腺癌（分类）
datasets.load_diabetes()   # 糖尿病（回归）
datasets.make_blobs()      # 合成聚类数据
datasets.make_classification()  # 合成分类数据
```

## 模型选择
```python
# 交叉验证
scores = model_selection.cross_val_score(model, X, y, cv=5)

# 网格搜索
from sklearn.model_selection import GridSearchCV

param_grid = {'C': [0.1, 1, 10], 'kernel': ['linear', 'rbf']}
gs = GridSearchCV(SVC(), param_grid, cv=5)
gs.fit(X_train, y_train)
gs.best_params_  # 最佳参数
gs.best_score_   # 最佳得分
```
