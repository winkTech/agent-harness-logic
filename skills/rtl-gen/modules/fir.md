# FIR Compiler — 基于 PG149 v7.2

**参考手册**: `D:\Project_Files\templates\fir\pg149-fir-compiler-en-us-7.2.pdf`（已转 `pg149-fir.md`）

---

## 手册架构概要（PG149）

### 支持的滤波器类型

| 类型 | 说明 | 适用场景 |
|:----|:------|:---------|
| **Single Rate** | 标准 FIR，输入输出速率相同 | 通用滤波、低通/高通/带通 |
| **Polyphase Decimator** | 多相抽取 FIR，降低采样率 | 下变频、降采样 |
| **Polyphase Interpolator** | 多相插值 FIR，提高采样率 | 上变频、升采样 |
| **Half-band Decimator** | 半带抽取 FIR（系数对称，每隔一个≈0） | 2:1 降采样 |
| **Half-band Interpolator** | 半带插值 FIR | 1:2 升采样 |
| **Hilbert Transform** | 希尔伯特变换（90°移相） | 正交信号生成 |
| **Interpolated** | 插值 FIR（系数间插零） | 窄带滤波 |

### 两种 MAC 架构

| 架构 | 特点 | 限制 |
|:----|:------|:-----|
| **Systolic MAC**（默认） | 脉动阵列，高吞吐，支持对称系数优化 | 分数率滤波不支持对称性利用 |
| **Transpose MAC** | 转置结构，无需额外流水线 | 不支持半带优化、不支持 Hilbert |

### 核心特性
- **系数**: 最多 1024 组系数集，每组 2~2048 个系数
- **数据位宽**: 最大 53-bit
- **系数位宽**: 最大 53-bit
- **通道数**: 最多 1024 个 TDM 通道
- **抽取/插值因子**: 最大 64（单通道最大 1024）
- **系数热加载**: 在线更新系数（RELOAD channel）
- **输出舍入**: 可选饱和/截断模式

### AXI4-Stream 接口

```
aclk ──────────── 全局时钟
aclken ────────── 时钟使能（可选）
aresetn ───────── 同步复位（低有效，最少 2 周期）

s_axis_data_tvalid ── 输入数据有效
s_axis_data_tready ── 输入数据就绪（反压）
s_axis_data_tdata ─── 输入数据总线
s_axis_data_tuser ─── 输入辅助数据（可选）
s_axis_data_tlast ─── 输入帧结束（可选）

m_axis_data_tvalid ── 输出数据有效
m_axis_data_tready ── 输出数据就绪（可选反压）
m_axis_data_tdata ─── 输出数据总线
m_axis_data_tuser ─── 输出辅助数据 / 通道 ID（可选）
m_axis_data_tlast ─── 输出帧结束（可选）

s_axis_config_* ───── 配置通道（系数选择/同步事件）
s_axis_reload_* ───── 系数热加载通道
```

### TDATA 结构
```
输入/输出共用数据结构，位宽 = 通道数 × 数据位宽（扩展到 8-bit 边界）
每个通道的数据在 tdata 中按顺序排列
```

---

## 参数表

| 参数 | 默认值 | 类型 | 说明 | 查询方式 |
|:----|:-------|:-----|:-----|:---------|
| `FILTER_TYPE` | "single_rate" | enum | **滤波器类型**: `single_rate` / `decimator` / `interpolator` / `halfband_dec` / `halfband_int` / `hilbert` | **询问用户** |
| `DATA_WIDTH` | 16 | int | **输入数据位宽**（1~53） | **询问用户** |
| `COEFF_WIDTH` | 16 | int | **系数位宽**（1~53） | **询问用户** |
| `NUM_COEFF_SETS` | 1 | int | **系数集数量**（1~1024） | **询问用户** |
| `COEFF_PER_SET` | 16 | int | **每组系数个数**（2~2048） | **询问用户** |
| `COEFF_VALUES` | — | array | **系数值数组**（按手册约定输入） | **询问用户** |
| `NUM_CHANNELS` | 1 | int | **TDM 通道数**（1~1024） | **询问用户** |
| `RATE_CHANGE` | 1 | int | **抽取/插值因子**（R=抽取或插值倍数，无速率变化=1） | **询问用户** |
| `ARCH_TYPE` | "systolic" | enum | **MAC 架构**: `systolic` / `transpose` | **询问用户** |
| `OUTPUT_ROUNDING` | "none" | enum | **输出舍入**: `none` / `truncate` / `saturate` | **询问用户** |
| `COEFF_RELOADABLE` | false | bool | **系数热加载**（需要 RELOAD 通道） | **询问用户** |
| `ENABLE_TUSER` | false | bool | **启用 tuser 辅助通道** | **询问用户** |
| `ENABLE_TLAST` | false | bool | **启用 tlast 帧信号** | **询问用户** |

### 参数校验规则
- `FILTER_TYPE=hilbert` → `ARCH_TYPE` 强制 `systolic`（Transpose 不支持 Hilbert）
- `FILTER_TYPE=halfband_*` → `ARCH_TYPE` 强制 `systolic`（Transpose 不支持半带优化）
- `COEFF_PER_SET` 必须 ≤ `NUM_CHANNELS` 的约束（多通道时每个通道用一个系数）
- 如果 `COEFF_RELOADABLE=true`，需要配置 RELOAD 通道参数

---

## 交互流程

### Step 1: 需求收集

按参数表顺序依次询问，**已经通过 args 提供的参数直接确认勿重复提问**。

**话术示例**:
```
1. "需要哪种 FIR 滤波器类型？（Single Rate / Decimator / Interpolator / Half-band / Hilbert）"
2. "输入数据位宽是多少？（默认 16）"
3. "系数位宽是多少？（默认 16）"
4. "需要几组系数？每组几个系数？"
5. "请提供具体的系数值（输入数组，如 [1, -2, 3, -4, 5, -4, 3, -2, 1]）"
6. "有几个 TDM 数据通道？（默认 1）"
7. "抽取/插值因子是多少？（单率=1，插值输出速率倍数，抽取输入速率倍数）"
8. "使用 Systolic 还是 Transpose MAC 架构？（默认 Systolic）"
9. "输出需要舍入/饱和处理吗？"
10. "需要在线系数热加载功能吗？"
11. "需要 tuser/tlast 辅助信号吗？"
```

### Step 2: 参数确认汇总

生成确认表，特别要展示**系数值**和**频率响应预期**。

### Step 3: RTL 代码生成

严格按以下模板结构生成 SystemVerilog 代码：

#### 代码模板结构

```systemverilog
//=============================================================================
// Module Name: fir_<type>_<tap>tap
// Description: FIR 滤波器（基于 PG149 FIR Compiler v7.2 架构）
//              - 类型: <FILTER_TYPE>
//              - MAC 架构: Systolic / Transpose
//              - AXI4-Stream 接口
// References:  PG149 FIR Compiler v7.2
//=============================================================================
module fir_#(
    parameter int P_DATA_W     = 16,
    parameter int P_COEFF_W    = 16,
    parameter int P_NUM_TAPS   = 16,
    parameter int P_CHANNELS   = 1,
    parameter int P_RATE       = 1,
    // 内部配置
    parameter int P_PIPE_DEPTH = 2   // MAC 流水线级数
) (
    input  logic                    i_clk,
    input  logic                    i_rst,
    input  logic                    i_clk_en,        // aclken
    // AXI4-Stream 输入
    input  logic                    i_s_axis_tvalid,
    output logic                    o_s_axis_tready,
    input  logic [P_DATA_W-1:0]     i_s_axis_tdata,
    // AXI4-Stream 输出
    output logic                    o_m_axis_tvalid,
    input  logic                    i_m_axis_tready,
    output logic [P_OUT_W-1:0]      o_m_axis_tdata
);

    // 内部声明
    localparam int P_PROD_W    = P_DATA_W + P_COEFF_W;
    localparam int P_ACCUM_W   = P_PROD_W + $clog2(P_NUM_TAPS);
    localparam int P_OUT_W     = (P_OUTPUT_ROUNDING == "saturate")
                                 ? P_ACCUM_W
                                 : P_DATA_W;

    // 系数 ROM / RAM
    localparam logic [P_COEFF_W-1:0] P_COEFFS [0:P_NUM_TAPS-1] = '{ /* 用户输入 */ };

    // MAC 引擎流水线
    // ...
```

#### FIR 生成规则（基于手册架构）

**Systolic MAC 实现**:
1. 系数存入 ROM 或分布式寄存器阵列
2. 输入数据移位寄存器链（延迟线）
3. 乘加树 — 多个 DSP slice 并行计算乘法
4. 加法树累加所有乘积
5. 流水线寄存器插入在乘法器和加法器之间
6. 输出寄存

**对于对称系数 FIR**（手册指出 systolic 支持对称优化）:
- 在乘加前先做对称抽头相加 → 减少 DSP 数量一半
- 先将输入延迟 `x(n)` 和 `x(N-1-n)` 相加，再乘以系数

**Polyphase 实现**:
- 分解为多个子滤波器（相），每个相处理一个插值/抽取相位
- 多相插值: 输入轮询写入各相 → 顺次读出
- 多相抽取: 输入顺次写入各相 → 轮询读出

**半带 FIR**:
- 利用一半系数为零的特性跳过多余的 MAC 运算

**乘法器输出位宽 = 输入位宽之和**: `P_PROD_W = P_DATA_W + P_COEFF_W`

### Step 4: 语法检查

```bash
vlog -lint fir_<type>_<tap>tap.sv   || \
iverilog -g2012 -t null -s fir_<type>_<tap>tap fir_<type>_<tap>tap.sv
```

### Step 5: 询问 Testbench

"是否需要生成对应的 Testbench？"
- 包含: 系数加载、输入数据生成、滤波器输出比对

---

## 重要提示

### 频率响应验证
生成 RTL 后建议用 MATLAB/Python 验证系数频率响应：
```python
# 在 Python 中快速验证
import numpy as np
coeff = [1, -2, 3, -4, 5, -4, 3, -2, 1]
w, h = np.freqz(coeff)
# 确认幅频响应满足设计要求
```

### 实现注意事项
- 考虑使用 DSP48 slice 实现乘法累加
- Systolic 架构中，每级 MAC 的输出需要寄存器流水
- 多通道时用 TDM 方式共享 MAC 引擎
- 插值滤波器输出速率 = 输入速率 × 插值因子

---

## 引用

| 资源 | 路径 |
|:----|:------|
| PG149 FIR Compiler 原始 PDF | `D:\Project_Files\templates\fir\pg149-fir-compiler-en-us-7.2.pdf` |
| PG149 转换 Markdown | `D:\Project_Files\templates\fir\pg149-fir.md` |
| 生产级 RTL 规范 | `../references/rtl-production-standards.md` |
| HDL 编码规范 | `../../hdl-coding/SKILL.md` |
| 算法硬件参考 | `../../hdl-coding/references/algorithm-hardware.md` |
