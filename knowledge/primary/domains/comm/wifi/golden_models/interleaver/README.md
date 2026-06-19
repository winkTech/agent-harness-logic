# 802.11 OFDM Block Interleaver Golden Model

802.11a/n/ac 发射端块交织器 (Block Interleaver) 与接收端去交织器 (Deinterleaver) 的 Python Golden Model。

## 功能

- 支持调制: **BPSK**, **QPSK**, **16QAM**, **64QAM**, **256QAM**
- 支持可配置 Nsd (数据子载波数):
  - 48 (802.11a)
  - 52 (802.11n 20 MHz)
  - 108 (802.11n 40 MHz)
  - 234 (802.11ac 80 MHz)
  - 468 (802.11ac 160 MHz)
- 802.11n/ac 频域旋转 (第三置换, 64QAM+)
- 多空间流支持 (通过 `iss` 参数)
- 可配置 `Nrot` 参数

## 算法

### 第一步置换 (列写入, 行读出)

```
i = Nrow * (k mod Ncol) + floor(k / Ncol)
```

其中 Ncol = 16, Nrow = Ncbps / Ncol。

### 第二步置换 (子块内旋)

```
j = s * floor(i/s) + ((i mod s) + g_rot) mod s
```

其中:
- s = max(Nbpsc / 2, 1)
- g_rot = (s*g + Ncbps - (Ncol * s * g) // Ncbps) mod s (按组恒定)
- g = floor(i / s)

> **注意**: 标准公式 `(i + Ncbps - floor(Ncol*i/Ncbps)) mod s` 在 Nrow % s != 0 时会产生碰撞。本实现使用修正公式, 将 g_rot 按组计算, 保证对所有合法 Ncbps 值双射。

### 第三步置换 (频域旋转, 802.11n/ac, 64QAM+)

```
r = (j - Nrow * Nrot * iss + Ncbps) mod Ncbps
```

- `iss=0` 时为单位置换 (单流无旋转)
- Nrot: 20MHz=11, 40MHz=29, 80MHz=58, 160MHz=116

## 快速开始

```python
from interleaver_gm import WiFiInterleaver, _fmt_table

# 创建 64QAM 交织器 (802.11a, 48 子载波)
il = WiFiInterleaver(modulation='64QAM', nsd=48, enable_rotation=False)

# 交织
tx = il.interleave(list(range(il.ncbps)))
print(tx[:8])  # [0, 16, 32, 48, 64, 80, 96, 112]

# 去交织 (恢复原始序列)
rx = il.deinterleave(tx)
assert rx == list(range(il.ncbps))
```

## API

### 构造函数

| 参数 | 类型 | 默认 | 说明 |
|:-----|:-----|:-----|:-----|
| `modulation` | str | 'BPSK' | 调制方式 |
| `nbpsc` | int \| None | None | 覆盖 modulation |
| `nsd` | int | 48 | 数据子载波数 |
| `enable_rotation` | bool \| None | None | None=自动 (64QAM+启用) |
| `n_rot` | int | 11 | 频域旋转参数 |

### 方法

| 方法 | 返回 | 说明 |
|:-----|:-----|:-----|
| `interleave(bits, iss=0)` | list[int] | 发射端块交织 |
| `deinterleave(bits, iss=0)` | list[int] | 接收端去交织 |
| `interleave_indices(iss=0)` | list[int] | 正向置换表 |
| `deinterleave_indices(iss=0)` | list[int] | 逆向置换表 |

## 约束

Ncbps (= Nsd * Nbpsc) 必须能被 Ncol (16) 整除。合法的 Nsd 取决于调制方式:

| Nsd | BPSK | QPSK | 16QAM | 64QAM | 256QAM |
|:----|:-----|:-----|:------|:------|:-------|
| 48  | OK | OK | OK | OK | OK |
| 52  | -- | -- | OK | -- | OK |
| 108 | -- | -- | OK | -- | OK |
| 234 | -- | -- | -- | -- | OK |
| 468 | -- | -- | OK | -- | OK |

## 文件结构

```
interleaver/
├── interleaver_gm.py          # Golden Model 主文件
├── test_interleaver.py        # 28 项测试
└── README.md                  # 本文件
```

## 验证状态

- 28 项测试全部通过
- ruff check 零警告
- Python 3.12 兼容

## 参考

- IEEE 802.11-2016, Section 19.3.11.7.3 (NON_HT 交织器)
- IEEE 802.11-2016, Section 21.3.11.7.3 (HT/VHT 交织器)
