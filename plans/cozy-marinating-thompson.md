# FFT/IFFT处理器实现计划

## Context
开发可实时配置128/256/512/1024/2048/4096点的基2 DIT流水线FFT/IFFT处理器，采用Q1.15定点格式。用于数字信号处理应用，需要满足严格的时序和定点数处理要求。

## 项目结构

```
prj/
├── 00_comm/
├── 01_src/
│   ├── 00_hdl/
│   │   ├── fft_top.v           # FFT/IFFT顶层模块
│   │   ├── butterfly.v         # 蝶形运算单元
│   │   ├── twiddle_rom.v       # 旋转因子ROM
│   │   ├── data_round.v        # 定点舍位模块
│   │   └── fft_ctrl.v          # 控制状态机
│   └── 01_ip/
├── 02_sim/
│   ├── tb_fft.v               # FFT测试文件
│   ├── run.do                 # Modelsim仿真脚本
│   └── test_data/             # 测试数据目录
├── 03_xdc/
├── 04_prj/
├── 05_bin/
├── 06_doc/
│   ├── FFT_design_spec.md     # 设计规格文档
│   └── verification_report.md # 验证报告
└── 08_py/
    ├── gen_test_data.py       # 测试数据生成
    └── verify_results.py      # 结果比对验证
```

## 模块设计

### 1. 顶层模块 fft_top.v

```verilog
module fft_top #(
    parameter MAX_N = 4096,    // 最大FFT点数
    parameter DATA_W = 16,     // Q1.15数据位宽
    parameter TWiddle_W = 16   // 旋转因子位宽
)(
    input  wire                  i_clk,
    input  wire                  i_rst,
    input  wire [2:0]            i_size_sel,  // 0:128, 1:256, 2:512, 3:1024, 4:2048, 5:4096
    input  wire                  i_inverse,   // 0:FFT, 1:IFFT
    input  wire signed [DATA_W-1:0] i_data_re,
    input  wire signed [DATA_W-1:0] i_data_im,
    input  wire                  i_data_valid,
    output wire signed [DATA_W-1:0] o_data_re,
    output wire signed [DATA_W-1:0] o_data_im,
    output wire                  o_data_valid,
    output wire                  o_overflow
);
```

### 2. 蝶形运算单元 butterfly.v

**算法**：基2 DIT蝶形运算
```
X[k] = A + W_N^k * B
X[k+N/2] = A - W_N^k * B
```

**流水线结构**（8级以内）：
1. 输入寄存（ri_前缀）
2. 乘法器（复数乘法，扩展为32位）
3. 收敛舍入（16位）
4. 加/减法运算
5. 输出寄存（ro_前缀）

### 3. 旋转因子ROM twiddle_rom.v

**存储策略**：
- 仅存储第一象限[0, π/2]的值
- 利用对称性生成其他象限
- Q1.15定点格式：cos/sin值 × 2^15

### 4. 控制状态机 fft_ctrl.v

```verilog
localparam P_ST_IDLE    = 3'd0;
localparam P_ST_LOAD    = 3'd1;
localparam P_ST_CALC    = 3'd2;
localparam P_ST_OUTPUT  = 3'd3;
```

## Q1.15定点处理

### 乘法扩展
```verilog
// Q1.15 × Q1.15 = Q2.30 (32位)
wire signed [31:0] mult_re = a_re * b_re - a_im * b_im;
wire signed [31:0] mult_im = a_re * b_im + a_im * b_re;
```

### 收敛舍入（32位→16位）
```verilog
wire [31:0] rounded = data_32 + 32'h0000_4000;
wire [15:0] result = rounded[30:15];
```

### 饱和处理
```verilog
wire overflow = (mult_re[31:30] != 2'b00 && mult_re[31:30] != 2'b11);
wire signed [15:0] sat_re = overflow ? (mult_re[31] ? 16'h8000 : 16'h7FFF) : mult_re[29:14];
```

## 测试验证方案

### 1. Python测试数据生成
- 单音信号：0.9 * sin(2π × freq × t)
- 多音信号：多个0.3幅度正弦波叠加
- 转换为Q1.15定点格式

### 2. Modelsim仿真
- 读取Python生成的测试数据
- 执行FFT/IFFT变换
- 输出结果到文件

### 3. 结果比对
- Python numpy.fft.fft作为参考
- 计算最大误差（应<1 LSB）
- 记录所有结果到验证报告

## 实施步骤

| 步骤 | 任务 | 验证方式 |
|------|------|----------|
| 1 | 创建项目目录结构 | 目录存在性检查 |
| 2 | 实现data_round.v | 单元仿真通过 |
| 3 | 实现butterfly.v | 蝶形运算正确性验证 |
| 4 | 实现twiddle_rom.v | ROM读取值正确 |
| 5 | 实现fft_ctrl.v | 状态机时序正确 |
| 6 | 实现fft_top.v | 128点FFT功能验证 |
| 7 | 支持所有点数配置 | 6种配置均通过 |
| 8 | 实现IFFT功能 | FFT+IFFT往返误差<1 |
| 9 | 编写Python验证脚本 | 比对结果正确 |
| 10 | 完整测试与文档 | 所有测试通过 |

## 验证标准

1. **功能正确性**：FFT/IFFT结果与Python numpy参考误差<1 LSB
2. **定点精度**：Q1.15定点数表示正确
3. **时序满足**：逻辑级数≤8，无时序违规
4. **可配置性**：所有6种点数配置正常工作
5. **溢出处理**：饱和截断正确，无数据溢出
