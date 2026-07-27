---
name: python-hardware-debug
description: Python 硬件调试工具箱，涵盖星座图绘制/频偏估计/EVM计算/采数分析/BER测试/寄存器配置
version: 1.0.0
---

# Python 硬件调试 Skill

> 版本: v1.0
> 适用范围: FPGA 调试阶段的 Python 数据分析
> 核心原则: 快速验证 > 可视化 > 自动报告

---

## 一、适用边界

### 必须使用的场景

| 场景 | 使用模板 |
|------|---------|
| FPGA 采数分析 (ILA/ChipScope) | `data_capture.py` |
| 调制质量验证 (EVM) | `evm_calc.py` |
| 星座图可视化 (QPSK/8PSK/16QAM) | `constellation.py` |
| 频偏估计与补偿 | `freq_estimate.py` |
| BER 误码率统计 | `ber_test.py` |
| 寄存器配置脚本生成 | `config_gen.py` |

### 可跳过的场景

- 已用 MATLAB 完成的分析
- 产线自动化测试 (使用专用测试框架)
- 纯文档描述

---

## 二、模板使用说明

所有模板位于 `templates/` 目录下，使用方式:

```bash
# 使用模板
python templates/constellation.py --file <iq_data.csv>
python templates/evm_calc.py --ref <ref.csv> --meas <meas.csv>
python templates/freq_estimate.py --file <iq.bin> --fs <sample_rate>
```

每个模板支持 `-h` 查看参数。

### 通用参数约定

| 格式 | 说明 | 示例 |
|:----|:----|:-----|
| IQ CSV | 两列 (I,Q), 纯文本或浮点 | `0.707,0.707` |
| IQ BIN | 二进制定点/浮点交织 | int16 ×2 交织 |
| 参数 JSON | 系统配置键值对 | `{"fc": 3.5e9}` |

---

## 三、安装依赖

```bash
pip install numpy matplotlib scipy pyserial pyvisa
```

---

## 四、调试工作流

### 4.1 典型流程

```
问题发现
   ↓
ILA/逻辑分析仪 捕获信号 → CSV 导出
   ↓
Python 模板分析 → 可视化 → 诊断结论
   ↓
修复 → 重新捕获验证
```

### 4.2 信号分析链

```python
# 典型调用链
from freq_estimate import estimate_cfo
from constellation import plot_constellation
from evm_calc import calculate_evm

# 1. 频偏估计
iq = load_iq("capture.bin")
cfo_hz = estimate_cfo(iq, fs=30.72e6)
print(f"CFO: {cfo_hz:.1f} Hz")

# 2. 频偏补偿后画星座图
iq_corrected = apply_cfo_correction(iq, cfo_hz, fs)
plot_constellation(iq_corrected, "Corrected Constellation")

# 3. EVM 分析
evm = calculate_evm(iq_corrected, ref_pattern="qpsk")
print(f"EVM: {evm:.2f}%")
```

---

## 五、模板详解

| 模板 | 核心函数 | 输入 | 输出 |
|:----|:---------|:----|:----|
| `constellation.py` | `plot_constellation()` | IQ 数组或文件 | 星座图 PNG |
| `freq_estimate.py` | `estimate_cfo()` | IQ 文件 + 采样率 | CFO 频率值 |
| `evm_calc.py` | `calculate_evm()` | 参考IQ + 测量IQ | EVM 报告 |
| `data_capture.py` | `CSVReader`, `BinaryReader` | 原始捕获文件 | 结构化 IQ 数据 |
| `ber_test.py` | `ber_test()` | 发送 + 接收比特 | BER 曲线 |
| `config_gen.py` | `gen_reg_config()` | 寄存器定义 JSON | 配置脚本 |
| **`matlab_cosim.py`** 🆕 | `run_cosim()` | 算法名 + MATLAB 脚本 | 对比报告 (EVM/频谱/波形) |
| `oran_analysis.py` | eCPRI/ORAN 帧解析 | PCAP 或原始二进制 | C-plane/U-plane 头 + BFP 解压数据 |

---

## 六、典型调试场景

### EVM 超差排查

```
EVM > 3.5% (256QAM)
  ├→ 频偏过大? → freq_estimate.py → 检查 LO
  ├→ 星座图旋转? → constellation.py → 相位噪声
  ├→ 星座图扩散? → evm_calc.py per subcarrier → 带内平坦度
  └→ 误码率高? → ber_test.py → 解调链路
```

### 接口调试

```
JESD204B 链路不通
  ├→ 寄存器配置? → config_gen.py gen init scripts
  ├→ 数据捕获? → data_capture.py parse ILA export
  └→ 数据验证? → data_capture.py check SYNC pattern
```

---

## 七、与 MATLAB 协同

| 场景 | Python (本 Skill) | MATLAB (MCP) |
|:----|:-----------------|:-------------|
| 快速可视化 | ✅ 星座图/时域波形 | — |
| 算法验证 | — | ✅ Golden Model |
| 产线测试 | ✅ 自动化脚本 | — |
| 定点化分析 | — | ✅ 精度评估 |
| 数据预处理 | ✅ CSV/二进制解析 | — |

**推荐**: Python 做快速分析和产线脚本，MATLAB 做算法规格验证。

---

## 八、版本历史

- v1.0 (2026-06-03): 初始版本，6 个调试模板
