---
name: python-basics/ch35-36-streamlit
description: Streamlit 快速构建应用 — 布局、交互、数据展示、部署
metadata:
  source: Book1《编程不难》Ch35-36
  type: reference
---

# Streamlit 应用开发

## 基础结构
```python
import streamlit as st
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

st.set_page_config(page_title="My App", layout="wide")

st.title("应用标题")
st.header("一级标题")
st.subheader("二级标题")
st.markdown("支持 **Markdown** 语法")
st.write("自动检测类型并渲染")
st.caption("小字说明")
```

## 交互组件
```python
# 文本输入
name = st.text_input("请输入名字")

# 数字/选择
age = st.number_input("年龄", min_value=0, max_value=150, value=25)
option = st.selectbox("选择一项", ["A", "B", "C"])
multi = st.multiselect("多选", ["X", "Y", "Z"])
rating = st.slider("评分", 1, 5, 3)

# 布尔
agree = st.checkbox("同意条款")
gender = st.radio("性别", ["男", "女"])

# 文件上传
uploaded = st.file_uploader("上传文件", type=['csv', 'xlsx'])
if uploaded:
    df = pd.read_csv(uploaded)
    st.dataframe(df)

# 日期/时间
date = st.date_input("选择日期")
```

## 布局
```python
# 侧边栏
with st.sidebar:
    st.header("控制面板")
    param = st.slider("参数", 0.0, 1.0, 0.5)

# 列布局
col1, col2, col3 = st.columns(3)
with col1:
    st.metric(label="温度", value="28°C", delta="2°C")
with col2:
    st.metric(label="湿度", value="65%")
with col3:
    st.metric(label="风速", value="12km/h")

# 选项卡
tab1, tab2 = st.tabs(["数据", "图表"])
with tab1:
    st.dataframe(df)
with tab2:
    st.line_chart(df)
```

## 数据展示
```python
st.dataframe(df, use_container_width=True)          # 交互式表格
st.table(df.head(10))                                # 静态表格
st.metric("指标名", "值", "变化量")                    # 指标卡片

# 图表
st.line_chart(df)         # 折线图（内置）
st.area_chart(df)         # 面积图（内置）
st.bar_chart(df)          # 柱状图（内置）
st.pyplot(fig)            # Matplotlib 图
st.plotly_chart(fig)      # Plotly 交互图
st.map(df)                # 地图
```

## 状态管理
```python
# Session State：跨 rerun 保持状态
if 'count' not in st.session_state:
    st.session_state.count = 0

if st.button("点击"):
    st.session_state.count += 1

st.write(f"点击次数: {st.session_state.count}")

# 缓存：避免重复计算
@st.cache_data
def load_large_data():
    return pd.read_csv('large_file.csv')

@st.cache_resource
def load_model():
    return joblib.load('model.pkl')
```

## 进度与反馈
```python
st.progress(progress_value)  # 进度条
st.spinner("加载中..."):     # 加载动画
st.success("成功")
st.info("提示信息")
st.warning("警告")
st.error("错误")
st.exception(e)              # 显示异常
st.balloons()                # 🎈 庆祝动画
```

## 运行与部署
```bash
# 运行
streamlit run app.py

# 常用 flag
streamlit run app.py --server.port 8501
streamlit run app.py --server.address 0.0.0.0

# 部署选项
# 1. Streamlit Community Cloud（免费）
# 2. Hugging Face Spaces
# 3. 自托管 Docker
```

## 完整示例：ML 应用
```python
import streamlit as st
import joblib
import pandas as pd

st.title("ML 模型预测器")

model = joblib.load('model.pkl')
feature_names = joblib.load('features.pkl')

with st.sidebar:
    st.header("输入参数")
    inputs = {}
    for feat in feature_names:
        inputs[feat] = st.number_input(feat, value=0.0)

if st.button("预测"):
    df = pd.DataFrame([inputs])
    pred = model.predict(df)[0]
    prob = model.predict_proba(df)[0].max()
    st.success(f"预测结果: {pred} (置信度: {prob:.2%})")
```
