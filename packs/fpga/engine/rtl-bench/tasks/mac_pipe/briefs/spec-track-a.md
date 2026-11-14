# 设计任务：3 级流水有符号乘累加 (MAC)

实现一个全流水有符号 MAC 模块，目标是让乘法器被综合进 DSP 硬核并在 250 MHz 收敛。

## 交付物

- 文件：`rtl/mac_pipe.sv`（SystemVerilog，单文件，可综合）
- 顶层模块名：`mac_pipe`

## 接口（端口名与位宽必须完全一致）

```systemverilog
module mac_pipe (
  input  wire               clk,
  input  wire               rst,      // 同步复位，高有效
  input  wire               s_valid,
  input  wire               s_clr,    // 本 beat 开始新累加
  input  wire signed [15:0] s_a,
  input  wire signed [15:0] s_b,
  output wire               m_valid,
  output wire signed [47:0] m_acc
);
```

## 行为契约

1. 每个 `s_valid=1` 的 beat 被无条件接收（无背压）；`s_valid=0` 时流水线空转，累加状态保持。
2. 累加语义（按输入顺序）：`s_clr=1` 的 beat 令 `acc = s_a*s_b`；`s_clr=0` 的 beat 令 `acc = acc_prev + s_a*s_b`。乘法为有符号 16×16，累加为有符号 48 位。
3. 延迟恰好 3 拍：某 beat 在时钟沿被采样后，第 3 个时钟沿 `m_valid=1` 且 `m_acc` 为**含该 beat** 的累加值。每个输入 beat 恰好产生一个输出 beat。
4. `m_valid` 与 `m_acc` 必须是寄存器直接输出；`m_valid=1` 时 `m_acc` 不得含 X/Z。
5. 复位（同步高有效）：流水线中未输出的 beat 作废，`m_valid` 为 0，累加状态清零；复位释放后首个 beat 即使 `s_clr=0` 也是从 0 开始累加。

## 综合目标（推断核查是硬门）

- 器件 `xc7a100tcsg324-2`，时钟 250 MHz（4.0 ns），综合后 WNS ≥ 0。
- **乘法器必须推断进 DSP（DSP ≥ 1）**——DSP=0 视为推断静默失败，直接不通过。3 级流水恰好对应 DSP48E1 的 AREG/MREG/PREG 全流水结构。
- 无 latch，无组合环路。

## 自测

工作区 `sim/tb_smoke.sv` 提供最小自测（顶层 `tb_smoke`）：

```bash
vlib work && vlog -sv rtl/mac_pipe.sv sim/tb_smoke.sv && vsim -c -onfinish stop work.tb_smoke -do "run -all; quit -f"
```

注意：smoke 只覆盖一条短帧，通过不代表满足全部契约（符号、位宽、延迟对齐、复位、气泡等由你不可见的完整测试判卷）。
