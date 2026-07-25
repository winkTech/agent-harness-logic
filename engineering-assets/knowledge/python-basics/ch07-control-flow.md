---
name: python-basics/ch07-control-flow
description: Python 控制结构 — if/elif/else、for/while、try/except、列表推导式
metadata:
  source: Book1《编程不难》Ch07
  type: reference
---

# Python 控制结构

## 条件语句 `if/elif/else`
```python
if score >= 90:
    print("优秀")
elif score >= 60:
    print("及格")
else:
    print("不及格")
```
- 条件后必须加冒号 `:`
- 用 `==` 判断相等，`=` 是赋值

## `for` 循环
```python
# 遍历字符串
for ch in "Python":
    print(ch)

# 遍历列表
for item in ["a", "b", "c"]:
    print(item)

# 搭配 enumerate 同时获取索引和值
for i, val in enumerate(["a", "b"]):
    print(i, val)

# 搭配 zip 并行遍历
for a, b in zip([1,2], ["x","y"]):
    print(a, b)
```

## `for...else` 语法
```python
for x in range(10):
    if x > 8:
        break
else:
    print("循环未被 break 打断时执行")
```

## `while` 循环
```python
i = 0
while i < 5:
    print(i)
    i += 1
```

## 循环控制
| 语句 | 作用 |
|------|------|
| `break` | 跳出整个循环 |
| `continue` | 跳过本次循环剩余代码，进入下一次 |
| `pass` | 占位符，什么也不做 |

## 异常处理 `try/except`
```python
try:
    x = 10 / 0
except ZeroDivisionError:
    print("除数不能为零")
except Exception as e:
    print(f"其他错误: {e}")
finally:
    print("无论是否异常都执行")
```

## 列表推导式（向量化替代方案）
```python
# 传统 for 循环
result = []
for i in range(10):
    result.append(i**2)

# 列表推导式（推荐）
result = [i**2 for i in range(10)]

# 带条件
even_squares = [i**2 for i in range(10) if i % 2 == 0]

# 嵌套循环推导
pairs = [(x, y) for x in [1,2] for y in ["a","b"]]
```
> **原则**：能用 `for` 循环的地方通常可以写成列表推导式，优先用向量化（NumPy/Pandas）替代显式循环。
