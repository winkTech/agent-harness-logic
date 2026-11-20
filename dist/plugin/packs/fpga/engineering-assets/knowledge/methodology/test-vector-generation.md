---
name: test-vector-generation
title: "测试向量生成规范"
domain: algorithm
tags: [test-vector, verification, co-simulation]
created: 2026-06-14
updated: 2026-06-14
difficulty: intermediate
applies_to: [algorithm-engineer, logic-engineer]
---

# 测试向量生成规范

> 算法工程师产出测试向量，逻辑工程师消费。格式统一、可自动化对比是核心。

---

## 1. 总体原则

| 原则 | 说明 |
|:-----|:------|
| **每模块独立向量集** | 避免交叉依赖 |
| **bit-true** | 定点 Golden Model 输出即是 RTL 的期望值 |
| **包含 corner case** | 边界值、饱和、溢出、复位后 |
| **可脚本化验证** | 向量配套 `check_<module>.py` 自检脚本 |

---

## 2. 向量格式

### 2.1 .hex（RTL 读取，$readmemh）

```hex
// scrambler_tv.hex
// 格式: 每行一个样点，十六进制
// 位宽: 16bit signed Q2.13
// 生成: algorithm-engineer / golden_model/tv_gen_scrambler.m
A2C1
3F5E
801A
...
```

**规范**：
- 注释头 3 行：功能、格式、来源
- 每行一个样点，固定位宽
- 大端序（MSB first）

### 2.2 .coe（BRAM 初始化）

```coe
; scrambler_init.coe
; 生成: algorithm-engineer / golden_model/tv_gen_scrambler.m
MEMORY_INITIALIZATION_RADIX=16;
MEMORY_INITIALIZATION_VECTOR=
A2C1,
3F5E,
801A,
...
```

### 2.3 .csv（Python 脚本读取）

```csv
# idx, golden_real, golden_imag
0, -0.1234, 0.5678
1, 0.9012, -0.3456
2, ...
```

---

## 3. 向量文件命名约定

```
<module>_<type>_<desc>.<ext>
     │        │       │
     │        │       └─ hex / coe / csv / mat
     │        └─ in / out / coeff / init / golden
     └─ 模块名（与 RTL 一致）
```

示例：
| 文件 | 说明 |
|:-----|:------|
| `scrambler_in.hex` | scrambler 输入向量 |
| `scrambler_golden.hex` | scrambler 期望输出 |
| `fft_coeff.hex` | FFT 旋转因子 |
| `fir_init.coe` | FIR 系数初始化 |

---

## 4. Corner Case 覆盖矩阵

**[MUST] 每模块必须覆盖以下场景：**

| 场景 | 覆盖方式 | 检查点 |
|:-----|:---------|:--------|
| 全零输入 | N 个连续 0 | 输出应为 0/直流偏置 |
| 全最大值 | N 个连续 max_val | 饱和处理正确 |
| 全最小值 | N 个连续 -max_val-1 | 负饱和正确 |
| 跳变沿 | min→max 跳变 | 建立时间/流水线正确 |
| 复位后 | 复位→首个有效数据 | 初值正确 |
| 溢出测试 | 输入超过典型范围 2× | 饱和/截断行为 |

每类 corner case **至少 10 个样点**。

---

## 5. 向量配套自检脚本

每个模块的测试向量必须配套 `check_<module>.py`：

```python
#!/usr/bin/env python3
"""
check_scrambler.py — scrambler 模块自检脚本
生成: algorithm-engineer
用法: python3 check_scrambler.py --sim-log ../sim/logs/scrambler_sim.log
"""

import json
import sys
import os

# ── 配置 ────────────────────────────────────────────
MODULE = "scrambler"
GOLDEN_FILE = "scrambler_golden.hex"    # 来自 algorithm-engineer
SIM_LOG = "../sim/logs/scrambler_sim.log"
TOLERANCE = 0                            # bit-true
NMSE_THRESHOLD_DB = -40

# ── 读取 golden ─────────────────────────────────────
def read_golden(path):
    with open(path) as f:
        return [int(line.strip(), 16) for line in f if line.strip() and not line.startswith('//')]

# ── 从仿真日志提取 RTL 输出 ──────────────────────────
def parse_sim_output(log_path):
    # 匹配类似: @OUTPUT: 0xA2C1
    import re
    outputs = []
    with open(log_path) as f:
        for line in f:
            m = re.search(r'@OUTPUT:\s*0x([0-9A-Fa-f]+)', line)
            if m:
                outputs.append(int(m.group(1), 16))
    return outputs

# ── 对比 ──────────────────────────────────────────────
def compare(golden, actual, tolerance=0):
    failures = []
    min_len = min(len(golden), len(actual))
    for i in range(min_len):
        err = abs(golden[i] - actual[i])
        if err > tolerance:
            failures.append({"index": i, "expected": golden[i], "actual": actual[i], "error": err})
    return failures

# ── 主函数 ────────────────────────────────────────────
def main():
    golden = read_golden(GOLDEN_FILE)
    actual = parse_sim_output(SIM_LOG)

    if len(actual) == 0:
        result = {"module": MODULE, "status": "ERROR", "reason": "No sim output found"}
        print(json.dumps(result))
        sys.exit(1)

    failures = compare(golden, actual, TOLERANCE)
    max_error = max((f["error"] for f in failures), default=0)

    # NMSE 计算
    import numpy as np
    g = np.array(golden[:len(actual)], dtype=float)
    a = np.array(actual, dtype=float)
    nmse = np.sum((g - a)**2) / np.sum(g**2)
    nmse_db = 10 * np.log10(max(nmse, 1e-30))

    status = "PASS"
    if len(failures) > 0 or nmse_db < NMSE_THRESHOLD_DB:
        status = "FAIL"

    result = {
        "module": MODULE,
        "status": status,
        "compared_points": min(len(golden), len(actual)),
        "max_error": max_error,
        "nmse_db": round(nmse_db, 2),
        "failed_points": failures[:10],
        "timestamp": os.popen('date -Iseconds').read().strip(),
    }

    # 输出 JSON 证据文件
    os.makedirs("../check_results", exist_ok=True)
    with open(f"../check_results/{MODULE}_result.json", "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps(result, indent=2))
    sys.exit(0 if status == "PASS" else 1)

if __name__ == "__main__":
    main()
```

---

## 6. 输出目录结构

```
03_golden/
├── tv_gen_scrambler.m          ← 向量生成脚本 (algorithm-engineer)
├── scrambler_in.hex            ← 输入向量
├── scrambler_golden.hex        ← 期望输出
├── check_scrambler.py          ← 自检脚本

02_sim/
├── check_results/
│   └── scrambler_result.json   ← 验证证据 (check.py 输出)
├── logs/
│   └── scrambler_sim.log       ← 仿真日志
└── check_scrambler.py          ← 链接或副本
```
