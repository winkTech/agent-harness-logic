---
name: wifi-bcc-encoder-golden-model
title: 802.11 BCC Encoder Golden Model
domain: comm
type: golden-model
tags: [wifi, 802.11, bcc, encoder, golden-model]
updated: 2026-07-03
---

# 802.11 BCC Encoder Golden Model

IEEE 802.11 Binary Convolutional Code (BCC) encoder reference implementation in pure Python.

## Overview

This golden model implements the convolutional encoder specified in IEEE Std 802.11-2016, Section 17.3.5.6. It is intended as a **bit-exact reference** for RTL implementation and verification.

### Encoder Specification

| Parameter        | Value                                                     |
|------------------|-----------------------------------------------------------|
| Constraint length| K = 7                                                     |
| Memory elements  | 6                                                         |
| Mother code rate | 1/2                                                       |
| Generator G1     | 133_8 (octal) — `1 + D^2 + D^3 + D^5 + D^6`             |
| Generator G2     | 171_8 (octal) — `1 + D + D^3 + D^4 + D^6`               |
| Punctured rates  | 2/3, 3/4, 5/6                                             |
| Tail bits        | 6 zero bits for zero-state termination                    |

### Encoder Structure

```
          +---[D1]---[D2]---[D3]---[D4]---[D5]---[D6]
          |    |             |      |                   |
input ----+----+------+------+------+---+---+----+----+---->
          |    |      |             |       |    |
          +----+------+------+------+       |    +--> A (G1=133)
          |         |      |                +--------> B (G2=171)
          +---------+------+-------+
```

Tap connections:
- **A output (G1=133)**: D0 xor D1 xor D3 xor D4 xor D6
- **B output (G2=171)**: D0 xor D2 xor D3 xor D5 xor D6

## Usage

```python
from bcc_encoder_gm import BCCEncoder

# Create encoder at rate 1/2 (default)
enc = BCCEncoder(rate=0.5)

# Encode a sequence of bits (each element is 0 or 1)
data = [1, 0, 1, 1, 0, 0, 1, 0]
encoded = enc.encode(data, tail=True)

# Change code rate
enc.set_rate(2/3)
encoded = enc.encode(data, tail=True)

# Encode without tail bits (for partial verification)
encoded_no_tail = enc.encode(data, tail=False)

# Single-bit encoding
a, b = enc.encode_bit(1)  # returns (A, B)
```

### Code Rates and Puncture Patterns

| Rate | Puncture Matrix (row-major: [A1..Ak, B1..Bk]) | Description              |
|------|-----------------------------------------------|--------------------------|
| 1/2  | `[1, 1]`                                       | Keep both A and B        |
| 2/3  | `[1, 0, 1, 1]`                                 | Drop B1 (2nd position)   |
| 3/4  | `[1, 0, 1, 1, 1, 0]`                           | Drop A2, B3              |
| 5/6  | `[1, 0, 1, 0, 1, 1, 0, 1, 1, 0]`               | Drop A2, A4, B2, B5      |

### Output Length

| Rate | Data output (n = input bits) | Tail output (always rate 1/2) |
|------|-----------------------------|-------------------------------|
| 1/2  | 2n                          | 12 bits                       |
| 2/3  | ceil(3n/2)                  | 12 bits                       |
| 3/4  | ceil(4n/3)                  | 12 bits                       |
| 5/6  | ceil(6n/5)                  | 12 bits                       |

## Files

| File                | Description                                         |
|---------------------|-----------------------------------------------------|
| `bcc_encoder_gm.py` | BCC Encoder class implementation                   |
| `test_bcc_encoder.py` | Pytest test suite with 30+ test cases            |
| `README.md`         | This file                                           |

## Running Tests

```bash
cd path/to/bcc_encoder
python -m pytest test_bcc_encoder.py -v
```

## Test Coverage

- Single-bit encoding verification
- Known-input trace (hand-computed)
- All code rate puncture pattern verification
- Output length formulas for all rates
- All-zero input produces all-zero output
- Tail bit zero-state termination
- Edge cases: empty input, single bit, invalid rates
- Data integrity (deterministic output, idempotent encode)

## Dependencies

- Python 3.12+
- pytest (for running tests)

## License

This golden model is provided as a reference for RTL implementation and verification.
