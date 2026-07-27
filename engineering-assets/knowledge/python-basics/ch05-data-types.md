---
name: python-basics/ch05-data-types
description: Python 数据类型 — 数字、字符串、列表、元组、字典、集合、布尔
metadata:
  source: Book1《编程不难》Ch05
  type: reference
---

# Python 数据类型

## 内置类型一览
| 类型 | 示例 | 可变 | 有序 |
|------|------|------|------|
| `int` | `x = 88` | — | — |
| `float` | `y = 3.14` | — | — |
| `complex` | `z = 8+8j` | — | — |
| `str` | `s = "hello"` | ❌ | ✅ |
| `list` | `a = [1,2,3]` | ✅ | ✅ |
| `tuple` | `b = (1,2,3)` | ❌ | ✅ |
| `set` | `c = {1,2,3}` | ✅ | ❌ |
| `dict` | `d = {"k":"v"}` | ✅ | ❌ (3.7+ 有序) |
| `bool` | `flag = True` | — | — |
| `NoneType` | `z = None` | — | — |

## 数字类型
```python
x = 88       # int
y = -8.88    # float
z = 8 + 8j   # complex（注意 j 不是 *j）

type(x)      # <class 'int'>
int(3.14)    # → 3
float("8.8") # → 8.8

8.8e3        # 科学计数法：8800.0
8.8e-3       # 0.0088
```

## 字符串
```python
s = 'single' + "double"  # 单引号双引号等效
s[0]         # 索引
s[1:3]       # 切片
len(s)       # 长度
str(123)     # → "123"
f"value={x}" # f-string（推荐）
```

## 列表 vs 元组
```python
lst = [1, 2, 3]
lst.append(4)    # [1,2,3,4]
lst.pop()        # → 4
lst[0] = 99      # 可修改

tup = (1, 2, 3)  # 不可修改
# 常用作函数多返回值、字典键
```

## 字典
```python
d = {"name": "Tom", "age": 18}
d["name"]        # → "Tom"
d.get("name")    # → "Tom"（安全访问）
d.keys()         # 所有键
d.values()       # 所有值
d.items()        # 所有键值对
```

## 集合
```python
s = {1, 2, 3, 3}     # → {1, 2, 3} 自动去重
s.add(4)
{1,2} | {2,3}         # 并集 {1,2,3}
{1,2} & {2,3}         # 交集 {2}
{1,2} - {2,3}         # 差集 {1}
```

## 类型转换
```python
int(x), float(x), str(x), list(x), set(x), dict(x)
# 注意：数字和字符串不能混合运算，如 2 + "1" → TypeError
```

## 深拷贝 vs 浅拷贝
```python
import copy
new_list = original_list.copy()    # 浅拷贝（嵌套对象仍共享）
new_list = copy.deepcopy(original) # 深拷贝（完全独立）
```
