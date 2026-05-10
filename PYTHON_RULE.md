# Python 代码约束

## 一、文件组织

### 1.1 目录结构
- Python 代码统一放入 `08_py/` 目录下
- 按模块功能划分子目录，每个模块一个包（含 `__init__.py`）
- 顶层脚本可直接放在 `08_py/` 下

### 1.2 文件命名
- 模块/文件名：全小写 + 下划线，如 `data_processor.py`
- 类文件：可使用单数名词，如 `fft_engine.py`
- 测试文件：以 `test_` 开头，如 `test_fft_engine.py`
- 避免使用 `-`（连字符）在文件名中

---

## 二、命名规范

| 类别 | 规范 | 示例 |
|------|------|------|
| 变量/函数 | 小写下划线（snake_case） | `data_length`、`calc_fft()` |
| 常量 | 全大写 + 下划线 | `SAMPLE_RATE_HZ`、`FFT_SIZE` |
| 类名 | 大驼峰（PascalCase） | `class FftEngine` |
| 私有成员 | 单下划线前缀 | `_internal_flag` |
| 特殊方法 | 双下划线包围 | `__init__`、`__len__` |
| 布尔变量 | 以 `is_`/`has_`/`enable_` 开头 | `is_valid`、`has_data` |
| 模块私有函数 | 单下划线前缀 | `_validate_input()` |

---

## 三、代码风格（遵循 PEP8）

### 3.1 格式要求
- 缩进：4 个空格（不使用制表符）
- 行宽：不超过 100 字符（ruff/flake8 配置）
- 运算符两侧加空格：`a + b` 而非 `a+b`
- 逗号后加空格：`func(a, b, c)` 而非 `func(a,b,c)`
- 函数定义前后空两行，类定义前后空两行
- 方法定义之间空一行

### 3.2 导入规范
```
# 标准库
import os
import sys
from pathlib import Path

# 第三方库
import numpy as np
import matplotlib.pyplot as plt

# 本地模块
from . import local_module
```
- 导入顺序：标准库 → 第三方 → 本地模块，每组之间空一行
- 禁止使用 `from module import *`

### 3.3 注释规范
- 所有公开函数/类必须有 docstring
- 使用 reStructuredText 风格或 Google 风格
```
def calc_snr(signal, noise):
    """计算信噪比。

    Parameters
    ----------
    signal : np.ndarray
        信号数据
    noise : np.ndarray
        噪声数据

    Returns
    -------
    float
        信噪比（dB）
    """
```
- 复杂算法步骤旁加行注释
- 禁止写"是什么"的注释（代码本身应可读），写"为什么"

---

## 四、编码规范

### 4.1 类型注解
- 所有函数参数和返回值必须有类型注解
```
def fft_process(data: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
```
- 复杂类型使用 `typing` 模块：`List`、`Dict`、`Optional`、`Tuple`

### 4.2 函数设计
- 单一职责原则：一个函数只做一件事
- 函数长度不超过 50 行（超过时拆分子函数）
- 参数数量不超过 5 个（超过时考虑用 `dataclass` 或 `**kwargs`）
- 禁止使用 `eval()`，避免使用 `exec()`

### 4.3 类设计
- 类应通过 `__init__` 明确初始化所有属性
- 使用 `@property` 替代 getter/setter 方法
- 继承层次不超过 3 层
- 使用 `dataclass` 简化数据容器类

### 4.4 错误处理
- 使用具体异常类型，禁止裸 `except:`
```
try:
    result = process(data)
except ValueError as e:
    logger.error("数据处理参数错误: %s", e)
    raise
except RuntimeError as e:
    logger.error("数据处理运行时错误: %s", e)
    raise
```
- 函数返回值一致，异常时抛异常而非返回 `None` 或错误码
- 使用 `logging` 模块，禁止 `print()`

---

## 五、性能相关

- 列表推导式优于 `for` + `append`
- 使用 `join()` 拼接字符串，避免 `+` 循环拼接
- 大数据集使用 NumPy 数组而非 Python 列表
- 文件操作使用 `with` 语句自动管理资源
- 优先使用 `pathlib.Path` 替代 `os.path`

---

## 六、NumPy / 数据处理规范

- 使用 `np.array()` 创建数组时明确 `dtype`
- 禁止在循环中调用 `np.append()`，预分配数组
- 比较浮点数用 `np.isclose()`，不用 `==`
- 矩阵运算优先使用 NumPy 内置函数（向量化）
- 随机数生成设置固定 seed 确保可复现

---

## 七、版本管理

- `.pyc` / `__pycache__/` 不提交（已在 .gitignore）
- `.venv/` / `venv/` 不提交
- 依赖文件 `requirements.txt` 或 `pyproject.toml` 可以提交
- 数据文件（`.csv`、`.npy`、`.mat`）不提交，除非很小且必须

---

## 八、代码检查

- 已安装 linter：`ruff` 0.15.12
- 提交前必须运行 lint 检查，确保零错误
```
ruff check <file>.py
```
- 常见警告应清零：
  - `F401` — 未使用的导入
  - `F841` — 未使用的变量
  - `E501` — 行超长（配置为 100 字符）
  - `N801` — 类命名不符合规范
