---
name: wifi-scrambler-golden-model
title: 802.11 Scrambler Golden Model
domain: comm
type: golden-model
tags: [wifi, 802.11, scrambler, golden-model]
updated: 2026-07-03
---

# 802.11 Scrambler Golden Model

WiFi 802.11 加扰器 Python 黄金模型。

## 规格

| 参数 | 值 |
|:-----|:----|
| 标准 | IEEE 802.11-2016, Section 17.3.5.5 |
| 多项式 | G(z) = z^7 + z^4 + 1 (x^7 + x^4 + 1) |
| 阶数 | 7 |
| LFSR 抽头 | [6, 3] (0-indexed) |
| 初始状态 | 0x7F (0111_1111, 全 1) |
| 周期 | 2^7 - 1 = 127 |
| 类型 | 自同步加扰 (self-synchronizing) |

### 工作原理

加扰和解扰是同一操作 (利用 XOR 的对称性):

```
每个时钟周期:
  1. fb = LFSR[6] XOR LFSR[3]
  2. out = data_in XOR fb
  3. LFSR = (LFSR << 1 | fb) & 0x7F
```

### SERVICE 字段

802.11 标准规定 SERVICE 字段前 7 bits 全部置 0, 用于接收端 LFSR 同步:

```
发送端:                                  接收端:
  Scrambler(0x7F)                          Scrambler(0x7F)
  ├─ 7 zero bits SERVICE     ──air──>      ├─ scrambled_service_bits
  ├─ DATA bits                              └─ descrambled DATA (原始)
  └─ scrambled bits out
```

## 文件结构

```
scrambler/
├── scrambler_gm.py      # Golden Model 主文件
├── test_scrambler.py    # 单元测试
└── README.md            # 本文档
```

## API 参考

### `Scrambler` 类

```python
from scrambler_gm import Scrambler

# 初始化 (默认 state = 0x7F)
s = Scrambler()
s = Scrambler(init_state=0x7F)

# 复位
s.reset()           # 复位到 0x7F
s.reset(0x00)       # 复位到自定义状态

# 单 bit 处理
out = s.next_bit(inp)  # inp: 0/1, out: 加扰后的 bit

# 字节序列处理 (LSB first)
scrambled = s.process(b"hello")
original = s.process(scrambled)  # 对称性

# Bit 列表处理
bits = [1, 0, 1, 0]
out_bits = s.process_bits(bits)

# SERVICE 字段同步
s = Scrambler()
result = s.process_with_service(data)
```

### 命令行

```bash
# 自检 (推荐首次使用前运行)
python scrambler_gm.py --test

# 加扰
python scrambler_gm.py --scramble 48656c6c6f

# 解扰 (同 --scramble)
python scrambler_gm.py --descramble 4f86

# SERVICE 字段 + DATA 加扰
python scrambler_gm.py --service 42

# 打印 LFSR 序列
python scrambler_gm.py --sequence 32
```

## 运行测试

```bash
# 使用 pytest (推荐)
pytest test_scrambler.py -v

# 直接运行
python test_scrambler.py

# 内置自检
python scrambler_gm.py --test
```

## 调用示例

### 基础加扰/解扰

```python
from scrambler_gm import Scrambler

data = b"Hello, WiFi!"
tx = Scrambler()
scrambled = tx.process(data)

rx = Scrambler()
recovered = rx.process(scrambled)
assert recovered == data  # True
```

### SERVICE 字段同步

```python
from scrambler_gm import Scrambler

data = bytes([0x42, 0x13, 0x37])

# 发送端
tx = Scrambler()
tx_output = tx.process_with_service(data)

# 接收端 (使用相同方法)
rx = Scrambler()
rx_data = rx.process_with_service(tx_output)
assert rx_data == data  # True
```

### 生成 LFSR 序列

```python
from scrambler_gm import generate_lfsr_sequence

seq = generate_lfsr_sequence(127)
print(f"LFSR 周期: {len(seq)}")
print(f"前 16 bits: {seq[:16]}")
```

## RTL 对齐要点

| 方面 | 说明 |
|:-----|:------|
| Bit 序 | 每个字节 LSB first, 与 802.11 标准一致 |
| 初始状态 | 0x7F, 复位到全 1 |
| 输出时序 | next_bit 每调用一次 = 一个时钟周期 |
| SERVICE | process_with_service 自动处理 7 个零 bit 同步 |
| 周期 | 127 bits 后重复, 用于验证 RTL LFSR 实现 |

## 与 MATLAB Golden 的关系

本模型的算法直接对应于 IEEE 802.11-2016 标准定义的加扰器。MATLAB WLAN
Toolbox 中的 `wlanScramble` 函数实现了相同功能。如需交叉验证, 对比
`Scrambler.process()` 的输出与 MATLAB `wlanScramble` 的结果即可。
