# TDD 工作流规范

> 严谨 · 敏捷 · 可持续

---

## 适用场景

### 必须使用 TDD
- 新建 Python 模块或函数
- 新建 MATLAB 函数文件
- 新建 RTL 模块（需编写 Testbench）
- 修复 Bug（需先编写复现测试）
- 重构现有代码（需先补充测试）
- 新增功能需求

### 可跳过 TDD
- 简单配置文件修改
- 文档更新
- 一次性脚本
- 样式调整（CSS/HTML）
- 明确的单行修复

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

| 阶段 | 规则 | 验证命令 |
|------|------|----------|
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

## 禁止事项

- ❌ 禁止先写代码再写测试
- ❌ 禁止跳过 RED 阶段直接写实现
- ❌ 禁止在 GREEN 阶段写多余代码
- ❌ 禁止 REFACTOR 后不验证测试

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

---

# 语言特定 TDD 约束

---

## HDL (Verilog/SystemVerilog) TDD 约束

> 基于仿真的测试驱动开发，遵循 @<RTL_DESIGN_RULE.md>

### 适用场景
- 新建 RTL 模块
- 修改关键时序逻辑
- 修复时序/功能 Bug
- 重构现有模块
- 新增状态机

### 测试框架与工具
| 工具 | 用途 | 命令 |
|------|------|------|
| ModelSim (vlog) | 编译检查 | `vlog -lint rtl/*.v tb/tb_*.v` |
| ModelSim (vsim) | 仿真运行 | `vsim -c -do run.do tb_<module>` |
| Vivado (xvlog) | 编译检查 | `xvlog rtl/*.v tb/tb_*.v` |
| Vivado (xelab) | 仿真 elaborate | `xelab tb_<module> -debug typical` |
| Vivado (xsim) | 仿真运行 | `xsim tb_<module> -runall` |
| gtkwave | 波形查看 | `gtkwave dump.vcd` |

### 仿真器选择
- **ModelSim**: 优先使用，支持 `vlog -lint` 语法检查，批处理模式 `vsim -c -do run.do`
- **Vivado**: 综合后仿真或无 ModelSim 环境时使用

### Testbench 文件规范
- 文件命名: `tb_<module_name>.v`（存放于 `02_sim/`）
- 模块命名: `tb_<module_name>`
- 时钟生成: 使用 `always #5 i_clk = ~i_clk`
- 波形输出: 使用 `$dumpfile` / `$dumpvars`（ModelSim 可用 `add wave`）

### RED 阶段 - 编写失败的 Testbench

```verilog
// 02_sim/tb_<module_name>.v
`timescale 1ns/1ps

module tb_<module_name>;

    // 信号声明
    reg         i_clk;
    reg         i_rst;
    reg  [7:0]  i_data;
    wire [7:0]  o_data;

    // 时钟生成
    initial i_clk = 0;
    always #5 i_clk = ~i_clk;

    // 实例化待测模块（此时模块未实现，编译失败 = RED）
    <module_name> uut (
        .i_clk(i_clk),
        .i_rst(i_rst),
        .i_data(i_data),
        .o_data(o_data)
    );

    // 测试激励
    initial begin
        $dumpfile("dump.vcd");
        $dumpvars(0, tb_<module_name>);

        // 复位测试
        i_rst = 1;
        i_data = 0;
        #100;
        i_rst = 0;
        #20;

        // 功能测试
        i_data = 8'hAA;
        #10;
        if (o_data !== 8'hAA) begin
            $display("FAIL: Expected 0xAA, got %h", o_data);
            $finish(1);
        end

        $display("PASS: All tests passed");
        $finish(0);
    end

endmodule
```

**验证标准:**
- `vlog` 或 `xvlog` 编译失败（模块不存在）= RED 成功
- 失败原因不是 Testbench 语法错误

### GREEN 阶段 - 编写最小实现

```verilog
// 01_src/00_hdl/<module_name>.v
module <module_name> (
    input  wire        i_clk,
    input  wire        i_rst,
    input  wire [7:0]  i_data,
    output wire [7:0]  o_data
);

    // 最小实现：直通
    assign o_data = i_data;

endmodule
```

**验证标准:**
- `vlog` 编译通过，或 `xvlog` + `xelab` 通过
- `vsim -c -do run.do` 或 `xsim -runall` 输出 "PASS"

### REFACTOR 阶段 - 优化代码

遵循 hdl-coding SKILL.md（§1 时序安全 + §2 命名规范）进行重构：
- 输入信号寄存（ri_ 前缀）
- 输出信号通过寄存器驱动（ro_ 前缀）
- 使用同步复位、高电平有效
- 添加模块头部注释
- 代码对齐规范化

**验证标准:**
- 仿真仍通过
- 符合 hdl-coding SKILL.md 命名规范
- `vlog -lint` 零警告

### HDL 必测场景
| 类型 | 场景 | 说明 |
|------|------|------|
| 复位 | 复位期间输出 | 复位时输出应为初始值 |
| 正常 | 正常输入输出 | 功能正确性 |
| 边界 | 最大值/最小值 | 位宽边界 |
| 时序 | 连续数据流 | 流水线正确性 |
| 异常 | 非法输入 | 错误处理 |

### HDL 质量门禁
```bash
# ModelSim 流程
# 1. 编译检查
vlog -lint rtl/*.v tb/tb_*.v

# 2. 仿真通过
vsim -c -do "run -all; quit -f" tb_<module>

# 3. Lint 检查（编译时已包含）

# Vivado 流程
# 1. 编译检查
xvlog rtl/*.v tb/tb_*.v

# 2. Elaborate
xelab tb_<module> -debug typical

# 3. 仿真通过
xsim tb_<module> -runall
```

### HDL 禁止事项
- ❌ 禁止使用 `initial` 初始化数组（用复位）
- ❌ 禁止组合逻辑输出（必须寄存）
- ❌ 禁止跳过复位测试
- ❌ 禁止不看波形就提交
- ❌ 禁止在可综合代码中使用 `#` 延迟

---

## Python TDD 约束

> 遵循 @<PYTHON_RULE.md> 的编码规范

### 适用场景
- 新建 Python 模块或函数
- 新建类和数据结构
- 修复 Bug（需先编写复现测试）
- 重构现有代码
- 新增 API 接口

### 测试框架与工具
| 工具 | 用途 | 命令 |
|------|------|------|
| pytest | 测试运行 | `pytest tests/ -v` |
| pytest-cov | 覆盖率 | `pytest --cov=src --cov-fail-under=80` |
| ruff | 代码检查 | `ruff check src/ tests/` |
| mypy | 类型检查 | `mypy src/` |

### 测试文件规范
- 测试目录: `08_py/tests/` 或 `tests/`
- 文件命名: `test_<module_name>.py`
- 函数命名: `test_<行为>_<条件>_<预期结果>`
- 类命名: `Test<功能名>`

### RED 阶段 - 编写失败的测试

```python
# tests/test_data_processor.py
import pytest
from data_processor import DataProcessor

class TestDataProcessor:
    """数据处理器测试类"""

    def test_输入有效数据_返回正确结果(self):
        """测试正常输入下的处理结果"""
        # Arrange
        processor = DataProcessor()
        input_data = [1, 2, 3]
        expected = 6

        # Act
        result = processor.sum_data(input_data)

        # Assert
        assert result == expected

    def test_输入空列表_抛出异常(self):
        """测试空列表输入时的异常处理"""
        processor = DataProcessor()

        with pytest.raises(ValueError, match="输入数据不能为空"):
            processor.sum_data([])

    def test_输入非数字_抛出类型异常(self):
        """测试非数字输入时的类型检查"""
        processor = DataProcessor()

        with pytest.raises(TypeError):
            processor.sum_data(["a", "b"])
```

**验证标准:**
- `pytest tests/ -v` 返回非 0（ImportError 或 AttributeError）
- 失败原因是"模块未实现"，不是测试代码语法错误

### GREEN 阶段 - 编写最小实现

```python
# src/data_processor.py
from typing import List, Union

class DataProcessor:
    """数据处理器"""

    def sum_data(self, data: List[Union[int, float]]) -> float:
        """计算数据总和。

        Parameters
        ----------
        data : List[Union[int, float]]
            输入数据列表

        Returns
        -------
        float
            数据总和

        Raises
        ------
        ValueError
            输入数据为空时抛出
        TypeError
            输入数据类型错误时抛出
        """
        if not data:
            raise ValueError("输入数据不能为空")

        if not all(isinstance(x, (int, float)) for x in data):
            raise TypeError("输入数据必须为数字")

        return sum(data)
```

**验证标准:**
- `pytest tests/ -v` 全部通过
- 代码量最小化

### REFACTOR 阶段 - 优化代码

遵循 PYTHON_RULE 进行重构：
- 添加类型注解
- 使用 logging 替代 print
- 函数长度不超过 50 行
- 使用 NumPy 向量化操作（如适用）
- 遵循 PEP8 规范

**验证标准:**
- 测试仍通过
- `ruff check` 零错误
- 代码符合 PYTHON_RULE

### Python 必测场景
| 类型 | 场景 | 说明 |
|------|------|------|
| 正常 | 有效输入 | 功能正确性 |
| 边界 | 空值/零值 | 边界条件处理 |
| 异常 | 类型错误 | 异常抛出正确 |
| 性能 | 大数据量 | 响应时间可接受 |
| 浮点 | 精度比较 | 使用 np.isclose() |

### Python 质量门禁
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

### Python 禁止事项
- ❌ 禁止使用 `eval()` / `exec()`
- ❌ 禁止裸 `except:` 捕获所有异常
- ❌ 禁止使用 `print()` 调试（用 logging）
- ❌ 禁止在循环中调用 `np.append()`
- ❌ 禁止使用 `from module import *`
- ❌ 禁止浮点数用 `==` 比较（用 `np.isclose()`）

---

## MATLAB TDD 约束

> 遵循 @<MATLAB_RULE.md> 的编码规范

### 适用场景
- 新建 MATLAB 函数文件
- 算法模块开发
- 修复数值计算 Bug
- 重构现有函数
- FPGA 算法建模

### 测试框架与工具
| 工具 | 用途 | 命令 |
|------|------|------|
| checkcode | 语法检查 | `matlab -batch "checkcode('<file>.m')"` |
| assert | 断言函数 | `assert(condition, message)` |
| validateattributes | 输入校验 | `validateattributes(x, {'numeric'}, ...)` |
| isequal / isequaln | 结果比较 | `isequal(result, expected)` |

### 测试文件规范
- 测试目录: `07_mat/02_script/test_<func_name>.m`
- 测试脚本命名: `test_<func_name>.m`
- 使用 `%%` 分节组织不同测试用例

### RED 阶段 - 编写失败的测试

```matlab
% 07_mat/02_script/test_calc_fft.m
%% 测试环境准备
clear variables;
addpath('../00_fx');
addpath('../01_conf');

%% 测试用例 1: 正常输入
% 准备测试数据
fs = 1000;                    % 采样率
t = 0:1/fs:1-1/fs;           % 时间向量
f1 = 50;                      % 信号频率
signal = sin(2*pi*f1*t);      % 生成正弦信号

% 调用待测函数（此时函数不存在，报错 = RED）
[fft_result, freq_axis] = calc_fft(signal, fs);

% 验证结果
assert(length(fft_result) == length(signal), 'FFT 长度不匹配');
[~, max_idx] = max(abs(fft_result));
assert(abs(freq_axis(max_idx) - f1) < 1, '频率检测不准确');

%% 测试用例 2: 边界条件 - 空输入
try
    calc_fft([], fs);
    error('应该抛出异常但未抛出');
catch ME
    assert(contains(ME.message, '输入'), '异常信息不正确');
end

%% 测试用例 3: 精度验证
% 定点数输入
fi_signal = fi(signal, 1, 16, 15);
[fft_fi, ~] = calc_fft(fi_signal, fs);
assert(isfi(fft_fi), '定点数输入应返回定点数结果');

disp('所有测试用例执行完毕');
```

**验证标准:**
- MATLAB 报错 "Undefined function 'calc_fft'" = RED 成功
- 失败原因是函数不存在，不是测试脚本语法错误

### GREEN 阶段 - 编写最小实现

```matlab
% 07_mat/00_fx/calc_fft.m
function [fft_result, freq_axis] = calc_fft(signal, fs)
% CALC_FFT - 计算信号的 FFT
% 输入：
%   signal - 输入信号（向量或 fi 对象）
%   fs     - 采样率（Hz）
% 输出：
%   fft_result - FFT 结果
%   freq_axis  - 频率轴（Hz）

    % 输入校验
    if isempty(signal)
        error('输入信号不能为空');
    end
    validateattributes(fs, {'numeric'}, {'positive', 'scalar'});

    % 最小实现
    N = length(signal);
    fft_result = fft(signal);
    freq_axis = (0:N-1) * fs / N;
end
```

**验证标准:**
- `matlab -batch "test_calc_fft"` 无报错
- 所有 assert 通过

### REFACTOR 阶段 - 优化代码

遵循 MATLAB_RULE 进行重构：
- 添加函数头部注释块
- 使用 validateattributes 校验输入
- 预分配数组
- 向量化操作替代循环
- 支持定点数（fi 对象）

**验证标准:**
- 测试仍通过
- `checkcode` 零警告
- 代码符合 MATLAB_RULE

### MATLAB 必测场景
| 类型 | 场景 | 说明 |
|------|------|------|
| 正常 | 有效输入 | 功能正确性 |
| 边界 | 空值/零值 | 边界条件处理 |
| 精度 | 浮点比较 | 使用容差值（eps） |
| 定点 | fi 对象 | FPGA 建模精度 |
| 性能 | 大数据量 | 向量化效果 |

### MATLAB 质量门禁
```bash
# 1. 语法检查
matlab -batch "checkcode('<file>.m'); exit;"

# 2. 运行测试
matlab -batch "test_<func_name>; exit;"

# 3. 检查覆盖率（手动确认）
# - 输入校验是否完整
# - 输出路径是否明确
# - 边界条件是否处理
```

### MATLAB 禁止事项
- ❌ 禁止在函数内使用 `clear all` / `clc`
- ❌ 禁止使用 `eval` / `feval`
- ❌ 禁止循环中动态扩容数组
- ❌ 禁止浮点数用 `==` 比较（用 `abs(a-b) < eps`）
- ❌ 禁止脚本中使用 `clear all`（用 `clear variables`）
- ❌ 禁止算法模块写成脚本（必须是函数）

---

## 语言 TDD 对比速查表

| 维度 | HDL | Python | MATLAB |
|------|-----|--------|--------|
| 测试框架 | Testbench + ModelSim/Vivado | pytest + pytest-cov | assert + checkcode |
| 测试文件 | `tb_<mod>.v` | `test_<mod>.py` | `test_<func>.m` |
| 测试目录 | `02_sim/` | `tests/` | `07_mat/02_script/` |
| 编译命令 | `vlog -lint` / `xvlog` | - | - |
| 运行命令 | `vsim -c -do run.do` / `xsim -runall` | `pytest tests/` | `matlab -batch "test_xxx"` |
| Lint 工具 | `vlog -lint` | `ruff check` | `checkcode()` |
| 覆盖率 | 波形检查 | pytest-cov ≥ 80% | 手动确认 |
| 断言方式 | `$display` + `$finish` | `assert` | `assert` |
| 浮点比较 | 位精确 | `np.isclose()` | `abs(a-b) < eps` |
| 输入校验 | Testbench 激励 | 类型注解 + raise | `validateattributes` |
| 必测项 | 复位/时序/边界 | 正常/异常/边界 | 正常/精度/定点 |
