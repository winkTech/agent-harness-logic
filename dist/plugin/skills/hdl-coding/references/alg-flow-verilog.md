# 算法模型 → Verilog 代码模板参考

> 流程执行见 `workflows/hdl-coding-workflow.md`（Phase 1-2: 算法分析/定点量化，Phase 3-4: TB/RTL）。
> 本文件提供代码模板、NMSE 判定标准和常见问题排查，供各阶段参考。
> 核心原则：**算法模型是黄金参考，RTL 必须逐 bit 对齐**。

---

## 适用场景

- FIR/IIR 滤波器设计
- FFT/IFFT 运算模块
- 数字混频（NCO/DDS）
- 调制解调算法
- 均衡器、相关器等 DSP 模块
- 任何需要从算法仿真到 FPGA/ASIC 实现的场景

---

## 浮点算法模型

### Python 实现要点

```python
import numpy as np

def algorithm_model(x, params):
    """浮点算法模型 - 黄金参考"""
    y = np.convolve(x, params['coeffs'], mode='valid')
    return y

# 生成测试激励
fs = 100e6          # 采样率
N  = 1024           # 样本数
t  = np.arange(N) / fs
x  = np.sin(2 * np.pi * 1e6 * t)  # 1MHz 正弦

# 获取 golden output
y_ref = algorithm_model(x, params)
```

### 输出要求

| 输出文件 | 格式 | 用途 |
|---------|------|------|
| `input_data.txt` | 十进制整数，每行一个样本 | Testbench 加载输入 |
| `golden_output.txt` | 十进制整数，每行一个样本 | Testbench 比对参考 |
| `input_data.hex` | 十六进制 | $readmemh 加载 |
| `params.json` | JSON | 参数配置（位宽、系数等） |

---

## 量化分析与定点化

### 位宽确定流程

```
浮点系数/数据
    ↓ 统计分析（最大值、最小值、动态范围）
    ↓ 确定整数位宽 IB = ceil(log2(max(|x|))) + 1 (符号位)
    ↓ 确定小数位宽 FB = 目标精度位数
    ↓ 总位宽 W = IB + FB
定点表示: Q(W-1).FB
```

### 量化策略选择

| 策略 | 适用场景 | Verilog 实现 |
|------|---------|-------------|
| 截断 (Truncate) | 精度要求不高，节省资源 | `assign y = x[W-1:FB];` |
| 四舍五入 (Round) | 通用场景 | `assign y = x[W-1:FB] + x[FB-1];` |
| 饱和截断 (Saturate) | 防溢出关键路径 | 需要溢出检测逻辑 |

### Python 定点化模型

```python
def float_to_fixed(x, W, FB):
    """浮点转定点 Q(W-1).FB"""
    scale = 2 ** FB
    x_fixed = np.clip(x * scale, -(2**(W-1)), 2**(W-1)-1)
    return np.round(x_fixed).astype(np.int64)

def fixed_to_float(x, W, FB):
    """定点转浮点"""
    return x / (2 ** FB)

def fixed_mul(a, b, W, FB):
    """定点乘法：结果右移 FB 位"""
    product = a * b
    return (product + (1 << (FB-1))) >> FB  # 四舍五入
```

---

## 参考数据生成

### 标准测试向量

```python
def gen_test_vectors(N, W, FB):
    """生成标准测试向量集"""
    vectors = {}

    # 1. 典型信号
    t = np.arange(N)
    vectors['sine_1fs4']    = float_to_fixed(np.sin(2*np.pi*t/4), W, FB)
    vectors['sine_1fs8']    = float_to_fixed(np.sin(2*np.pi*t/8), W, FB)
    vectors['impulse']      = float_to_fixed(np.where(t==0, 1.0, 0.0), W, FB)
    vectors['step']         = float_to_fixed(np.ones(N), W, FB)

    # 2. 边界值
    vectors['max_pos']      = np.full(N, 2**(W-1)-1, dtype=np.int64)
    vectors['max_neg']      = np.full(N, -(2**(W-1)), dtype=np.int64)
    vectors['alternating']  = np.array([(-1)**i for i in range(N)], dtype=np.int64) * (2**(W-1)-1)

    # 3. 随机数据
    vectors['random']       = float_to_fixed(
        np.random.uniform(-1, 1, N), W, FB
    )

    return vectors
```

### 输出为 Verilog 可读格式

```python
def save_for_verilog(data, filename, fmt='dec'):
    """保存为 Verilog testbench 可读格式"""
    with open(filename, 'w') as f:
        for val in data:
            if fmt == 'dec':
                f.write(f"{val}\n")
            elif fmt == 'hex':
                f.write(f"{val:016X}\n")
            elif fmt == 'coe':
                f.write(f"{val:X},\n" if val != data[-1] else f"{val:X};\n")
```

---

## Verilog RTL 实现

### 位宽匹配检查清单

- [ ] 每个中间变量位宽与定点模型一致
- [ ] 乘法器输出位宽 = A_WIDTH + B_WIDTH
- [ ] 加法器输出位宽 = max(A_WIDTH, B_WIDTH) + 1
- [ ] 溢出处理策略与模型一致
- [ ] 截断/舍入位置与模型一致

### 常见模块模板

```verilog
// 定点乘法器 (Q(WA-1).FBA × Q(WB-1).FBB → Q(WY-1).FBY)
module fixed_mult #(
    parameter WA = 16, FBA = 14,
    parameter WB = 16, FBB = 14,
    parameter WY = 32, FBY = 28
)(
    input  signed [WA-1:0] a,
    input  signed [WB-1:0] b,
    output signed [WY-1:0] y
);
    wire signed [WA+WB-1:0] product = a * b;
    // 四舍五入右移
    assign y = product[WA+WB-1:FBA+FBB] + product[FBA+FBB-1];
endmodule

// 定点加法器 (饱和处理)
module fixed_add #(
    parameter W = 16, FB = 14
)(
    input  signed [W-1:0] a,
    input  signed [W-1:0] b,
    output signed [W-1:0] y,
    output overflow
);
    wire signed [W:0] sum = {a[W-1], a} + {b[W-1], b};
    assign overflow = (sum[W] != sum[W-1]);
    assign y = overflow ? (sum[W] ? {1'b1, {(W-1){1'b0}}} : {1'b0, {W-1{1'b1}}})
                        : sum[W-1:0];
endmodule
```

---

## 仿真验证与比对

### Testbench 框架

```verilog
`timescale 1ns/1ps
module tb_algorithm;
    parameter W = 16, FB = 14;
    parameter N = 1024;

    reg  clk, rst;
    reg  signed [W-1:0] din;
    wire signed [W-1:0] dout;
    wire                 dout_valid;

    // 加载参考数据
    reg signed [W-1:0] input_mem [0:N-1];
    reg signed [W-1:0] golden_mem [0:N-1];
    reg signed [W-1:0] output_mem [0:N-1];

    integer i, error_count;
    real max_error;

    initial begin
        $readmemh("input_data.hex", input_mem);
        $readmemh("golden_output.hex", golden_mem);
    end

    // DUT 实例化
    algorithm_top #(.W(W), .FB(FB)) u_dut (
        .clk(clk), .rst(rst),
        .din(din), .din_valid(1'b1),
        .dout(dout), .dout_valid(dout_valid)
    );

    // 时钟
    initial clk = 0;
    always #5 clk = ~clk;

    // 测试流程
    initial begin
        rst = 1; din = 0; error_count = 0; max_error = 0;
        #100; rst = 0;

        for (i = 0; i < N; i = i + 1) begin
            @(posedge clk);
            din = input_mem[i];
        end

        // 等待输出完成
        repeat(N) @(posedge clk);

        // 比对
        for (i = 0; i < N; i = i + 1) begin
            if (output_mem[i] !== golden_mem[i]) begin
                $display("Mismatch at %0d: got %0d, expected %0d",
                         i, output_mem[i], golden_mem[i]);
                error_count = error_count + 1;
            end
        end

        $display("Errors: %0d / %0d", error_count, N);
        if (error_count == 0) $display("PASS");
        else $display("FAIL");
        $finish;
    end

    // 输出采集
    always @(posedge clk) begin
        if (dout_valid) output_mem[i] <= dout;
    end
endmodule
```

### Python 自动比对脚本（含 NMSE 验证）

```python
import numpy as np
import sys

def calc_nmse(reference, test):
    """
    计算 NMSE (Normalized Mean Square Error)
    NMSE = Σ(x[n] - x̂[n])² / Σ(x[n])²
    返回值越小越好，一般要求 < -40dB (FB=16 时)
    """
    error = reference.astype(float) - test.astype(float)
    nmse_linear = np.sum(error**2) / (np.sum(reference.astype(float)**2) + 1e-30)
    nmse_db = 10 * np.log10(nmse_linear + 1e-30)
    return nmse_linear, nmse_db

def calc_snr(reference, test):
    """计算 SNR (Signal-to-Noise Ratio)"""
    error = reference.astype(float) - test.astype(float)
    signal_power = np.mean(reference.astype(float)**2)
    noise_power  = np.mean(error**2)
    return 10 * np.log10(signal_power / (noise_power + 1e-30))

def compare_results(golden_file, rtl_file, W, FB, nmse_threshold_db=-40, verbose=True):
    """
    比对 golden output 与 RTL 输出，以 NMSE 为主要验证指标
    """
    golden = np.loadtxt(golden_file, dtype=np.int64)
    rtl    = np.loadtxt(rtl_file, dtype=np.int64)

    assert len(golden) == len(rtl), f"长度不匹配: {len(golden)} vs {len(rtl)}"

    diff = golden - rtl
    exact_match = np.all(diff == 0)

    # --- 核心指标：NMSE ---
    nmse_linear, nmse_db = calc_nmse(golden, rtl)

    # --- 辅助指标 ---
    max_err  = np.max(np.abs(diff))
    mean_err = np.mean(np.abs(diff))
    rms_err  = np.sqrt(np.mean(diff.astype(float)**2))
    snr      = calc_snr(golden, rtl)
    sqnr_theoretical = 6.02 * FB + 1.76

    # --- 判定 ---
    nmse_pass = nmse_db < nmse_threshold_db  # NMSE 越小越好

    if verbose:
        print(f"{'='*55}")
        print(f"  RTL 验证结果 (NMSE 判定)")
        print(f"{'='*55}")
        print(f"  样本数:       {len(golden)}")
        print(f"  完全匹配:     {'YES' if exact_match else 'NO'}")
        print(f"  ---")
        print(f"  NMSE:         {nmse_db:.2f} dB  (门限: < {nmse_threshold_db} dB)")
        print(f"  NMSE (线性):  {nmse_linear:.2e}")
        print(f"  判定:         {'PASS' if nmse_pass else 'FAIL'}")
        print(f"  ---")
        print(f"  最大误差:     {max_err} LSB")
        print(f"  平均误差:     {mean_err:.4f} LSB")
        print(f"  RMS 误差:     {rms_err:.4f} LSB")
        print(f"  SNR:          {snr:.2f} dB")
        print(f"  理论 SQNR:    {sqnr_theoretical:.2f} dB")
        print(f"{'='*55}")

    return {
        'pass': nmse_pass,
        'exact_match': exact_match,
        'nmse_db': float(nmse_db),
        'nmse_linear': float(nmse_linear),
        'max_error': int(max_err),
        'snr_db': float(snr),
        'error_count': int(np.sum(diff != 0))
    }

if __name__ == '__main__':
    # 用法: python verify_rtl.py golden.txt rtl.txt W FB [nmse_threshold_db]
    golden_file = sys.argv[1]
    rtl_file    = sys.argv[2]
    W           = int(sys.argv[3])
    FB          = int(sys.argv[4])
    threshold   = float(sys.argv[5]) if len(sys.argv) > 5 else -40.0

    result = compare_results(golden_file, rtl_file, W, FB, threshold)
    sys.exit(0 if result['pass'] else 1)
```

---

## NMSE 判定标准

| 位宽 (W) | 小数位 (FB) | 理论 SQNR | NMSE 门限建议 |
|-----------|-------------|-----------|--------------|
| 12 | 10 | 61.96 dB | < -55 dB |
| 16 | 14 | 86.04 dB | < -80 dB |
| 18 | 16 | 98.08 dB | < -92 dB |
| 24 | 22 | 134.20 dB | < -128 dB |

**经验公式：** NMSE 门限 ≈ 理论 SQNR - 6 dB（留 6dB 余量）

---

## 常见问题排查

| 现象 | 可能原因 | 排查方法 |
|------|---------|---------|
| 全部样本差 1 | 舍入方式不一致 | 检查模型和 RTL 的舍入策略 |
| 前几个样本对，后面错 | 流水线延迟未补偿 | 检查 Testbench 中的延迟对齐 |
| 部分样本大误差 | 溢出未处理 | 检查中间级位宽和饱和逻辑 |
| 符号相反 | 有符号/无符号混用 | 统一使用 signed |
| 完全不匹配 | 时序问题 | 检查时钟、复位、valid 信号 |

---

## 关键原则

1. **算法模型是唯一真相** — RTL 实现必须向模型对齐，不是反过来
2. **位宽一致性** — 模型和 RTL 的每个中间变量位宽必须完全一致
3. **量化策略一致性** — 截断/舍入/饱和在模型和 RTL 中必须相同
4. **自动化比对** — 不要手动肉眼对比，用脚本逐样本检查
5. **边界测试** — 不仅要测典型信号，还要测极端值和随机数据
