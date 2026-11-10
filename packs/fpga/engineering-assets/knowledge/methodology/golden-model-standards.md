---
name: golden-model-standards
title: "Golden Model 编码规范"
domain: algorithm
tags: [golden-model, matlab, python, standards]
created: 2026-06-14
updated: 2026-06-14
difficulty: intermediate
applies_to: algorithm-engineer
---

# Golden Model 编码规范

> Golden Model 是 RTL 的唯一权威参照。它必须正确、可复现、可分段对标。

---

## 1. 黄金原则

```
╔═════════════════════════════════════════════════════╗
║  Golden Model = 算法规范 + 实现参考 + 测试基准      ║
║  RTL 的行为必须与 Golden Model 完全一致              ║
║  不一致时：先查 RTL → 再查 Golden → 差异在 issue 记录 ║
╚═════════════════════════════════════════════════════╝
```

---

## 2. 代码结构

### 2.1 模块级分段

**每一算法步骤 = 一个独立函数**，与 RTL 模块一一对应：

```matlab
function golden_model_main()
    % 全链路 Golden Model

    % Step 1: scrambler        ← 与 RTL module scrambler 对应
    data_scrambled = scrambler(data_in, config);

    % Step 2: fft              ← 与 RTL module fft 对应
    data_freq = fft_transform(data_scrambled, config);

    % Step 3: equalizer        ← 与 RTL module equalizer 对应
    data_eq = equalizer(data_freq, channel_est, config);

    % 全链对比点输出
    save_intermediate('scrambled_out', data_scrambled);
    save_intermediate('fft_out', data_freq);
    save_intermediate('eq_out', data_eq);
end
```

### 2.2 浮点/定点分离

```
golden_model/
├── float/                     ← 浮点参考（算法验证用）
│   ├── ofdm_float.m
│   └── ...
├── fixed/                     ← 定点模型（bit-true，产生测试向量）
│   ├── ofdm_fixed.m
│   └── ...
├── tv_gen/                    ← 测试向量生成
│   ├── tv_gen_scrambler.m
│   └── ...
└── utils/                     ← 工具函数
    ├── quantize.m
    ├── save_intermediate.m
    └── ...
```

### 2.3 中间值导出

**[MUST] 每模块输出中间值到文件，供 RTL 分段对标：**

```matlab
function save_intermediate(name, data, config)
    % 格式: 每行一个样点，十六进制
    filename = sprintf('%s_%s.hex', config.snapshot_prefix, name);
    fid = fopen(filename, 'w');
    fprintf(fid, '// %s intermediate output\n', name);
    fprintf(fid, '// Format: 16bit hex, signed\n');
    fprintf(fid, '// Source: golden_model %s\n\n', config.version);

    for i = 1:length(data)
        % 定点量化到指定位宽
        q = quantize_fixed(data(i), config.bit_width, config.frac_bits);
        fprintf(fid, '%04X\n', typecast(int16(q), 'uint16'));
    end
    fclose(fid);
end
```

---

## 3. API 规范

### 3.1 MATLAB 函数接口

```matlab
function [y, debug_info] = <module>_golden(x, config, debug_mode)
% <模块名> Golden Model
% 输入:
%   x          - 输入信号 [N×C] (N样点 × C通道)
%   config     - 配置结构体（位宽/模式/参数）
%   debug_mode - (可选) true=导出中间值，false=仅输出
% 输出:
%   y          - 输出信号
%   debug_info - 调试信息结构体

    % 默认参数
    if nargin < 3, debug_mode = false; end

    % 算法主体
    % ...

    % debug 模式导出
    if debug_mode
        save_intermediate('<module>_in', x, config);
        save_intermediate('<module>_out', y, config);
    end
end
```

### 3.2 Python 等效

```python
from dataclasses import dataclass
from typing import Optional
import numpy as np

@dataclass
class ModuleConfig:
    bit_width: int = 16
    frac_bits: int = 13
    mode: str = 'normal'

def module_golden(
    x: np.ndarray,
    config: ModuleConfig,
    debug_mode: bool = False
) -> tuple[np.ndarray, dict]:
    """模块 Golden Model（Python 版本）
    
    Args:
        x: 输入信号 [N, C]
        config: 配置参数
        debug_mode: 是否导出中间值
    
    Returns:
        y: 输出信号
        debug_info: 调试信息
    """
    # 算法主体
    # ...
    
    debug_info = {}
    if debug_mode:
        debug_info['input'] = x.copy()
        debug_info['output'] = y.copy()
    
    return y, debug_info
```

---

## 4. 版本管理

```
golden_model/
└── 03_golden/
    ├── v1.0/                  ← 初始版本
    │   ├── ofdm_golden.m
    │   └── tv_gen/
    ├── v1.1/                  ← 定点优化版本
    │   ├── ofdm_golden.m
    │   └── tv_gen/
    └── RELEASE.md             ← 版本变更日志
```

**每次 RTL tapeout 前 Golden Model 必须固定版本**，不接受 "正在改" 的 Golden Model。

---

## 5. 验收标准

| 检查项 | 要求 |
|:-------|:-----|
| 浮点模型自洽 | 数学公式 → 代码 → 仿真三方一致 |
| 定点 vs 浮点退化 | NMSE ≤ −50dB（高安全模块） |
| 可重复性 | 相同输入 → 相同输出（固定 seed） |
| 分段对标 | 每模块独立可调用、可保存中间值 |
| 测试向量自动生成 | 单脚本生成全模块向量集 |
