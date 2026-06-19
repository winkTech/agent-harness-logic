# Golden Model 设置指南

## 语言选择：Python 优先

Python 是 golden model 的**最佳选择**，原因如下：

| 特性 | Python | MATLAB |
|:-----|:--------|:--------|
| 跨平台 | Windows/Linux/Mac 原生 | 需单独安装，各平台行为有差异 |
| 可脚本化 | 原生脚本语言 | 需 `-batch` / `-nodisplay` 模式 |
| 版本控制友好 | 纯文本，diff 清晰 | `.m` 文件可 diff，但依赖 Toolbox 版本 |
| 许可证 | 免费开源 | 商业许可证，每台机器需单独激活 |
| CI/CD 集成 | 零配置 | 需要安装 MATLAB Runtime |
| 数值库 | numpy/scipy 完备 | 需 Signal Processing / Communications Toolbox |
| 社区生态 | 活跃，WiFi 模型丰富 | 需要专业工具箱 |

## 适用场景

| 场景 | 使用 Python | 使用 MATLAB |
|:-----|:------------|:------------|
| Golden Model (算法参考) | **推荐** | 仅当算法团队提供 MATLAB 参考时 |
| 定点量化验证 | **推荐** | 仅当已有 MATLAB Fixed-Point Designer 流程 |
| 仿真峰值吞吐对比 | **推荐** | 可选 |
| 与算法团队对齐 | 当算法团队用 Python 时 | 当算法团队用 MATLAB 时 |

## 目录结构约定

```
golden_models/
  <module>/
    <module>_gm.py          # Golden model 实现
    <module>_gm_test.py     # 测试（可选，可内联在 _gm.py 中）
    README.md               # 模块说明（可选）
```

### 目录结构示例

```
golden_models/
  scrambler/
    scrambler_gm.py         # 扰码器 golden model
  viterbi/
    viterbi_gm.py           # Viterbi 译码器 golden model
  ldpc/
    ldpc_encoder_gm.py      # LDPC 编码器 golden model
    ldpc_decoder_gm.py      # LDPC 译码器 golden model
  fft/
    fft_gm.py               # FFT golden model
```

## 每个 Golden Model 模块的强制要求

每个 golden model 模块 **必须** 提供以下四个要素：

### a) Python 函数实现

核心算法作为独立函数实现，输入输出有类型注解和文档字符串：

```python
import numpy as np
from typing import Optional, Tuple

def scrambler_golden(
    data: np.ndarray,
    init_state: int = 0x7F,
    polynomial: int = 0b1111101,
    descramble: bool = False
) -> np.ndarray:
    """802.11 scrambler golden model.

    Args:
        data: Input bits (0/1), shape (N,)
        init_state: Initial scrambler state (7 bits), default 0x7F (all-ones)
        polynomial: Generator polynomial (7 bits), default 0b1111101 (x^7 + x^4 + 1)
        descramble: If True, run descrambler instead of scrambler

    Returns:
        Scrambled/descrambled bits, same shape as data

    Reference: IEEE 802.11-2020 Section 17.3.5.4
    """
    state = init_state & 0x7F
    output = np.zeros_like(data)

    for i in range(len(data)):
        # LFSR feedback: bit 6 XOR bit 3 (0-indexed: taps at positions 6 and 3)
        feedback = ((state >> 6) ^ (state >> 3)) & 1
        # Output: data XOR feedback
        output[i] = data[i] ^ feedback if not descramble else data[i] ^ feedback
        # Shift state
        state = ((state << 1) | feedback) & 0x7F

    return output
```

### b) 命令行测试入口

模块必须支持直接运行进行自我测试：

```python
if __name__ == '__main__':
    import sys

    # Test mode: run known answer test
    if '--test' in sys.argv:
        run_test()
    # Interactive mode: process input from command line
    elif len(sys.argv) > 1:
        data = np.array([int(b) for b in sys.argv[1]], dtype=np.uint8)
        result = scrambler_golden(data)
        print(''.join(str(b) for b in result))
    else:
        # Default: run self-test
        print("Scrambler Golden Model")
        print("Usage: python scrambler_gm.py [--test] <binary_string>")
        run_test()
```

### c) 内置测试向量

每个模块必须包含 `known_answer` 测试向量列表：

```python
def run_test():
    """Run built-in known-answer tests."""
    test_vectors = [
        {
            'name': 'all_zeros_scramble',
            'input': np.zeros(127, dtype=np.uint8),
            'init_state': 0x7F,
            'descramble': False,
            'expected': None,  # Will compute expected by running twice
        },
        {
            'name': 'scramble_then_descramble',
            'input': np.random.default_rng(42).integers(0, 2, 1000).astype(np.uint8),
            'init_state': 0x7F,
            'descramble': False,
            'expected': None,
        },
    ]

    all_passed = True
    for tv in test_vectors:
        # Scramble
        scrambled = scrambler_golden(tv['input'], tv['init_state'])
        # Descramble
        descrambled = scrambler_golden(scrambled, tv['init_state'], descramble=True)
        # Verify: descramble(scramble(x)) == x
        if not np.array_equal(descrambled, tv['input']):
            print(f"  FAIL: {tv['name']}")
            all_passed = False
        else:
            print(f"  PASS: {tv['name']}")

    if all_passed:
        print("All tests passed!")
    else:
        print("Some tests FAILED!")
        sys.exit(1)
```

### d) 定点量化参数配置

固定点配置必须集中管理，方便 RTL 对齐：

```python
from dataclasses import dataclass

@dataclass
class FixedPointConfig:
    """定点量化参数配置"""
    # 数据位宽
    DATA_WIDTH: int = 8
    # 小数位宽
    FRAC_WIDTH: int = 4
    # 符号位
    SIGNED: bool = True
    # 量化模式: 'trunc' | 'round' | 'round_convergent'
    QUANT_MODE: str = 'trunc'
    # 溢出处理: 'saturate' | 'wrap'
    OVERFLOW_MODE: str = 'saturate'

    def to_fixed(self, value: float) -> int:
        """Convert float to fixed-point integer."""
        scale = 2 ** self.FRAC_WIDTH
        max_val = (2 ** (self.DATA_WIDTH - 1)) - 1 if self.SIGNED else (2 ** self.DATA_WIDTH) - 1
        min_val = -(2 ** (self.DATA_WIDTH - 1)) if self.SIGNED else 0

        quantized = round(value * scale) if self.QUANT_MODE == 'round' else int(value * scale)

        if self.OVERFLOW_MODE == 'saturate':
            quantized = max(min_val, min(max_val, quantized))
        else:
            # Wrap
            range_size = max_val - min_val + 1
            quantized = ((quantized - min_val) % range_size) + min_val

        return quantized

    def to_float(self, fixed_val: int) -> float:
        """Convert fixed-point integer back to float."""
        return fixed_val / (2 ** self.FRAC_WIDTH)
```

## 与 MATLAB golden model 的互操作

如果算法团队提供 MATLAB 参考实现，建议：

1. **不要修改 MATLAB 文件** — 受 `08-constraints.md` [MUST NOT] 规则保护
2. **用 Python 重写** — 将 MATLAB 算法翻译为 Python，保持算法方向一致
3. **交叉验证** — 用 MATLAB 输出作为测试向量，验证 Python 实现
4. **MATLAB 测试向量导出**：
   ```matlab
   % 在 MATLAB 中运行
   data = randi([0 1], 1, 1000);
   result = my_function(data);
   save('test_vectors.mat', 'data', 'result');
   ```
   然后在 Python 中加载验证。

## 参考实现位置

所有 golden model 实现应放置在：

```
knowledge/primary/domains/comm/wifi/golden_models/
```

请遵循上述约定，确保 golden model 可测试、可复用、可版本控制。
