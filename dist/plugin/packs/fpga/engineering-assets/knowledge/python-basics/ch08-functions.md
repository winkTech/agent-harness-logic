---
name: python-basics/ch08-functions
description: Python 函数 — def、参数类型、lambda、作用域、递归
metadata:
  source: Book1《编程不难》Ch08
  type: reference
---

# Python 函数

## 函数定义基础
```python
def function_name(param1, param2):
    """docstring：函数说明"""
    result = param1 + param2
    return result
```
- `def` 关键字定义函数
- `return` 返回值；不写 `return` 则返回 `None`
- docstring（`"""`）写在函数体第一行

## 参数类型

### 位置参数（按顺序传入）
```python
def f(a, b):
    return a + b

f(1, 2)  # 位置匹配
```

### 关键字参数（指定参数名）
```python
f(b=2, a=1)  # 顺序可调换
```

### 默认参数
```python
def f(a, b=10):
    return a + b

f(5)     # → 15
f(5, 2)  # → 7
```

### 可变参数
```python
def f(*args, **kwargs):
    # *args → 元组，接收所有位置参数
    # **kwargs → 字典，接收所有关键字参数
    print(args, kwargs)

f(1, 2, x=3, y=4)
# (1, 2) {'x': 3, 'y': 4}
```

## Lambda 匿名函数
```python
square = lambda x: x**2
square(5)  # → 25

# 常用于 map/filter/sorted
list(map(lambda x: x*2, [1,2,3]))       # → [2,4,6]
sorted([(1,"b"), (2,"a")], key=lambda x: x[1])  # 按第二个元素排序
```

## 作用域规则
| 层级 | 关键字 | 说明 |
|------|--------|------|
| 局部 | — | 函数内定义的变量 |
| 嵌套 | `nonlocal` | 闭包中修改外层函数的变量 |
| 全局 | `global` | 在函数内修改模块级变量 |
| 内置 | — | Python 内置名称 |

```python
x = 10  # 全局
def f():
    global x
    x = 20  # 修改全局
```

## 多返回值
```python
def min_max(lst):
    return min(lst), max(lst)  # 返回元组

lo, hi = min_max([3,1,4,1,5])
```

## 装饰器（高阶函数）
```python
def timer(func):
    def wrapper(*args, **kwargs):
        import time
        start = time.time()
        result = func(*args, **kwargs)
        print(f"耗时: {time.time()-start:.3f}s")
        return result
    return wrapper

@timer
def slow_function():
    import time
    time.sleep(1)
```

## 内置常用函数
| 函数 | 说明 |
|------|------|
| `len()` | 返回长度 |
| `range(n)` | 生成 `0..n-1` 整数序列 |
| `enumerate(seq)` | 返回 `(索引, 值)` 迭代器 |
| `zip(a, b)` | 并行打包多个序列 |
| `map(f, seq)` | 对每个元素应用函数 |
| `filter(f, seq)` | 筛选满足条件的元素 |
| `sorted(seq)` | 返回排序后的新列表 |
| `type(obj)` | 返回对象类型 |
