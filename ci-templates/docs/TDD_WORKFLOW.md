# TDD 工作流规范

> 严谨 · 敏捷 · 可持续

---

## 核心原则

### Red-Green-Refactor 循环

```
┌─────────────────────────────────────────────────────────────┐
│                     TDD 严格循环                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐               │
│   │   RED   │───▶│  GREEN  │───▶│ REFACTOR│               │
│   │ 写失败  │    │ 写通过  │    │  优化   │               │
│   │ 的测试  │    │ 的代码  │    │  代码   │               │
│   └─────────┘    └─────────┘    └─────────┘               │
│        │                              │                     │
│        └──────────────────────────────┘                     │
│                    持续循环                                  │
└─────────────────────────────────────────────────────────────┘
```

### 严格规则

| 阶段 | 规则 | 验证 |
|------|------|------|
| **RED** | 测试必须先失败 | `pytest -x --tb=short` 返回非 0 |
| **GREEN** | 最少代码使测试通过 | `pytest` 全部通过 |
| **REFACTOR** | 重构后测试仍通过 | `pytest` 全部通过 |

---

## 工作流程

### 1. 开始新功能

```bash
# 创建功能分支
git checkout -b feat/<功能名>

# 运行 TDD 循环
./scripts/tdd-cycle.sh start "<功能名>"
```

### 2. RED 阶段 - 写失败测试

```bash
# 进入 RED 阶段
./scripts/tdd-cycle.sh red

# 编写测试（此时测试应该失败）
# 编辑 tests/test_<功能>.py

# 验证测试失败
./scripts/tdd-cycle.sh verify-red
```

**验证标准：**
- 测试必须失败
- 失败原因是"功能未实现"，不是语法错误
- 错误信息清晰明确

### 3. GREEN 阶段 - 写最小通过代码

```bash
# 进入 GREEN 阶段
./scripts/tdd-cycle.sh green

# 编写最小实现代码
# 编辑 src/<模块>.py

# 验证测试通过
./scripts/tdd-cycle.sh verify-green
```

**验证标准：**
- 所有测试通过
- 代码量最小化（不写多余功能）
- 不破坏现有功能

### 4. REFACTOR 阶段 - 优化代码

```bash
# 进入 REFACTOR 阶段
./scripts/tdd-cycle.sh refactor

# 重构代码（保持测试通过）
# 优化结构、命名、消除重复

# 验证测试仍通过
./scripts/tdd-cycle.sh verify-refactor
```

**验证标准：**
- 所有测试通过
- 代码更清晰
- 无重复代码
- 符合编码规范

### 5. 完成一个循环

```bash
# 完成当前循环
./scripts/tdd-cycle.sh done

# 提交代码
git add <相关文件>
git commit -m "feat(<模块>): <描述> [TDD cycle <N>]"
```

---

## 测试规范

### 测试命名规范

```python
# 格式: test_<行为>_<条件>_<预期结果>

# 示例
def test_输入有效数据_返回正确结果():
    ...

def test_输入空值_抛出异常():
    ...

def test_网络超时_返回默认值():
    ...
```

### 测试结构（AAA 模式）

```python
def test_功能描述():
    # Arrange - 准备
    input_data = ...
    expected = ...

    # Act - 执行
    result = function_under_test(input_data)

    # Assert - 断言
    assert result == expected
```

### 测试覆盖率要求

| 类型 | 最低覆盖率 |
|------|-----------|
| 单元测试 | 90% |
| 集成测试 | 70% |
| 总体 | 80% |

---

## 质量门禁

### 提交前检查（必须全部通过）

```bash
# 1. 测试通过
pytest tests/ -v --tb=short

# 2. 覆盖率达标
pytest tests/ --cov=src --cov-report=term-missing --cov-fail-under=80

# 3. 代码风格
ruff check src/ tests/

# 4. 类型检查（可选）
mypy src/
```

### CI 检查

每次推送自动执行：
- ✅ 所有测试通过
- ✅ 覆盖率 ≥ 80%
- ✅ 无 lint 错误
- ✅ 无安全漏洞

---

## TDD 检查清单

### 每个循环结束时

- [ ] 测试先失败（RED）
- [ ] 最小代码使测试通过（GREEN）
- [ ] 重构后测试仍通过（REFACTOR）
- [ ] 无破坏现有功能
- [ ] 代码符合规范
- [ ] 提交信息规范

### 每个功能结束时

- [ ] 所有测试通过
- [ ] 覆盖率达标
- [ ] 文档已更新
- [ ] 代码已审查
- [ ] 无 TODO/FIXME 遗留

---

## 常见错误

### ❌ 错误做法

```python
# 1. 先写代码再写测试
def add(a, b):
    return a + b

# 测试已经知道实现，失去验证意义
def test_add():
    assert add(1, 2) == 3  # 这样写没有价值
```

### ✅ 正确做法

```python
# 1. 先写测试（RED）
def test_add_正数相加():
    assert add(1, 2) == 3  # 此时 add 未实现，测试失败

# 2. 写最小实现（GREEN）
def add(a, b):
    return a + b  # 最小实现

# 3. 重构（REFACTOR）
# 如果需要，优化代码结构
```

---

## 工具链

| 工具 | 用途 | 命令 |
|------|------|------|
| pytest | 测试运行 | `pytest tests/` |
| pytest-cov | 覆盖率 | `pytest --cov=src` |
| ruff | 代码检查 | `ruff check .` |
| mypy | 类型检查 | `mypy src/` |
| pre-commit | 提交检查 | `git commit` 自动触发 |

---

## 快速参考

```bash
# 开始新功能 TDD
./scripts/tdd-cycle.sh start "用户认证"

# 执行 TDD 循环
./scripts/tdd-cycle.sh red      # RED: 写失败测试
./scripts/tdd-cycle.sh verify-red  # 验证测试失败
./scripts/tdd-cycle.sh green    # GREEN: 写最小代码
./scripts/tdd-cycle.sh verify-green  # 验证测试通过
./scripts/tdd-cycle.sh refactor # REFACTOR: 优化代码
./scripts/tdd-cycle.sh verify-refactor  # 验证重构后仍通过
./scripts/tdd-cycle.sh done     # 完成当前循环

# 查看状态
./scripts/tdd-cycle.sh status
```
