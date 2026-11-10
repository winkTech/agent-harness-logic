---
name: python-basics/ch04-syntax
description: Python 语法基础 — 注释、缩进、变量、import 导入、命名规范
metadata:
  source: Book1《编程不难》Ch04
  type: reference
---

# Python 语法基础

## 注释
```python
# 单行注释
x = np.arange(10)  # 行尾注释

def my_function(x, y):
    """多行注释/docstring
    函数输入: x, y
    函数输出: x + y
    """
    return x + y
```

## 缩进
- Python 用缩进（4个空格）代替花括号标识代码块
- 冒号 `:` 后下一行必须缩进
- 常见缩进场合：`if/elif/else`、`for/while`、函数/类定义、`try/except`
- 禁止混用 tab 和空格；IndentationError 是最常见的报错之一

## 变量
- 动态类型：无需声明类型，Python 自动推断
- `x, y, z = 1, 2, 3` — 多变量赋值
- `x = y = z = 0` — 链式赋值
- `x += 1` — 增量赋值（等价于 `x = x + 1`）

### 命名规则
- 字母、数字、下划线组成，不能数字开头
- 区分大小写：`my_var` vs `My_var` 不同
- 不能用保留关键字（`if`, `else`, `while`...）
- **约定**：变量/函数用蛇形命名法（`snake_case`），类用驼峰命名法（`CamelCase`）

## import 导入（4 种方式）
```python
import numpy                  # 完整导入，调用时 numpy.array()
import numpy as np            # ✅ 别名导入（推荐）
from numpy import array       # 部分导入，直接调用 array()
from numpy import *           # ❌ 不推荐，污染命名空间
```

### 常用库约定简称
| 库 | 全称 | 简称 | 用途 |
|---|---|---|---|
| NumPy | numpy | np | 多维数组、线性代数 |
| Pandas | pandas | pd | 数据帧、数据处理 |
| Matplotlib | matplotlib.pyplot | plt | 绘图 |
| Seaborn | seaborn | sns | 统计可视化 |
| Plotly | plotly.express | px | 交互可视化 |
| Streamlit | streamlit | st | 构建应用 |

## Pythonic 风格
- 遵循 **PEP 8**（代码风格指南）
- 优先用内置函数和数据结构（列表、字典、集合、生成器）
- 用 `try/except` 处理异常，不用 `if` 预检查
- 避免全局变量，用函数/类封装状态
- 编写文档和测试
- [PEP 8 官方文档](https://peps.python.org/pep-0008/)
