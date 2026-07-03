---
name: wifi-qam-mapper-golden-model
title: 802.11 QAM Mapper — Golden Model
domain: comm
type: golden-model
tags: [wifi, 802.11, qam, mapper, golden-model]
updated: 2026-07-03
---

# 802.11 QAM Mapper — Golden Model

IEEE 802.11-2016 compliant QAM modulation/demodulation Golden Model in Python.

## Supported Modulations

| Mode     | Bits/Symbol | Normalization Factor | Gray Coding |
|:---------|:-----------|:---------------------|:------------|
| BPSK     | 1          | 1                    | 1 bit (trivial) |
| QPSK     | 2          | 1/√2                 | I/Q independent |
| 16QAM    | 4          | 1/√10                | 2-bit Gray per axis |
| 64QAM    | 6          | 1/√42                | 3-bit Gray per axis |
| 256QAM   | 8          | 1/√170               | 4-bit Gray per axis |

## Files

| File | Description |
|:-----|:------------|
| `qam_mapper_gm.py` | Golden Model implementation |
| `test_qam_mapper.py` | Comprehensive test suite (pytest) |
| `README.md` | This file |

## Usage

```python
from qam_mapper_gm import QAMMapper

# Create a 16QAM mapper with normalization
mapper = QAMMapper('16QAM', norm=True)

# Map bits to symbol
iq = mapper.map([0, 0, 1, 1])   # → (0.316, -0.949)

# Hard-decision demap
bits = mapper.demap((0.316, -0.949))  # → [0, 0, 1, 1]

# Batch operation
import numpy as np
symbols = mapper.map_symbols([0,0,0,0, 0,1,0,1])  # complex ndarray
bits_back = mapper.demap_symbols(symbols)

# LLR soft output
llr = mapper.calc_llr((0.3, -0.9), noise_var=0.5)
```

## Key Features

- **Gray coding** matching 802.11-2016 Section 17.3.5.8
- **Power normalization** switchable via `norm=` parameter
- **Fixed-point quantization** via `fixed_point=` (Q-format fractional bits)
- **Soft-output LLR** using max-log-MAP approximation
- **Batch processing** with numpy arrays
- **Constellation visualisation** via `get_constellation_points()`

## Test Vectors

Built-in test vectors verify every modulation:

| Modulation | Vectors | Coverage |
|:-----------|:--------|:---------|
| BPSK       | 2       | All possible inputs |
| QPSK       | 4       | All possible inputs |
| 16QAM      | 16      | All possible inputs |
| 64QAM      | 32      | 4 I-levels x 8 Q-levels |
| 256QAM     | 256     | Full identity check |

## Verification

```bash
# Run all tests
pytest test_qam_mapper.py -v

# Run with coverage
pytest test_qam_mapper.py -v --cov=qam_mapper_gm

# Lint
ruff check qam_mapper_gm.py test_qam_mapper.py
```

## License

Golden Model for 802.11 QAM mapping.
