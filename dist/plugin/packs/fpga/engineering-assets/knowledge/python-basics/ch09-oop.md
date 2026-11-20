---
name: python-basics/ch09-oop
description: Python 面向对象编程 — 类、对象、继承、封装、多态
metadata:
  source: Book1《编程不难》Ch09
  type: reference
---

# Python 面向对象编程 (OOP)

## 类与对象
```python
class Dog:
    """类的 docstring"""
    # 类属性（所有实例共享）
    species = "Canis familiaris"

    # __init__：构造方法，实例化时自动调用
    def __init__(self, name, age):
        self.name = name  # 实例属性
        self.age = age

    # 实例方法
    def bark(self):
        return f"{self.name} says woof!"

    # 特殊方法：字符串表示
    def __str__(self):
        return f"{self.name} ({self.age}岁)"

# 实例化
my_dog = Dog("Rex", 5)
print(my_dog.bark())   # → "Rex says woof!"
print(my_dog.species)  # → "Canis familiaris"
```

## 继承
```python
class Puppy(Dog):  # 继承 Dog
    def __init__(self, name, age, toy):
        super().__init__(name, age)  # 调用父类构造
        self.toy = toy

    # 重写父类方法
    def bark(self):
        return f"{self.name} yaps!"

    # 新增方法
    def play(self):
        return f"{self.name} plays with {self.toy}"
```

## 封装与属性
```python
class Temperature:
    def __init__(self, celsius=0):
        self._celsius = celsius  # _前缀：约定为内部属性

    @property
    def fahrenheit(self):
        """只读属性（getter）"""
        return self._celsius * 9/5 + 32

    @fahrenheit.setter
    def fahrenheit(self, value):
        """setter：赋值时自动转换"""
        self._celsius = (value - 32) * 5/9
```

## 常用特殊方法
| 方法 | 作用 |
|------|------|
| `__init__(self, ...)` | 构造函数 |
| `__str__(self)` | `str(obj)` / `print(obj)` |
| `__repr__(self)` | 开发调试用字符串 |
| `__len__(self)` | `len(obj)` |
| `__eq__(self, other)` | `==` 比较 |
| `__lt__(self, other)` | `<` 比较 |
| `__add__(self, other)` | `+` 运算 |

## @classmethod vs @staticmethod
```python
class MyClass:
    @classmethod
    def factory(cls, value):
        """类方法：接收类作为第一个参数"""
        return cls(value)

    @staticmethod
    def helper(x):
        """静态方法：与类相关但不访问实例/类属性"""
        return x * 2
```

## 命名约定
| 模式 | 含义 | 示例 |
|------|------|------|
| `name` | 公开属性/方法 | `self.name` |
| `_name` | 内部/受保护（约定） | `self._internal` |
| `__name` | 名称改写（避免子类冲突） | `self.__private` |
| `__name__` | 特殊方法 | `__init__` |
