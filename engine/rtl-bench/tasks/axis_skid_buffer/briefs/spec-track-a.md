# 设计任务：AXI-Stream 寄存切片 (skid buffer)

实现一个 AXI-Stream 寄存切片模块，用于打断 valid/ready 时序路径而不损失吞吐。

## 交付物

- 文件：`rtl/axis_skid_buffer.sv`（SystemVerilog，单文件，可综合）
- 顶层模块名：`axis_skid_buffer`

## 接口（端口名与位宽必须完全一致）

```systemverilog
module axis_skid_buffer #(
  parameter int DATA_W = 16
)(
  input  wire              clk,
  input  wire              rst,       // 同步复位，高有效
  input  wire              s_valid,
  output wire              s_ready,
  input  wire [DATA_W-1:0] s_data,
  output wire              m_valid,
  input  wire              m_ready,
  output wire [DATA_W-1:0] m_data
);
```

## 行为契约

1. AXI-Stream 握手：`valid && ready` 于时钟上升沿完成一次传输；`m_valid` 置位后在握手完成前不得撤销，期间 `m_data` 不得改变。
2. 无丢失、无重复、无乱序：进入的 beat 严格按序、恰好一次地从 m 侧输出。
3. 满吞吐：`s_valid` 与 `m_ready` 持续为 1 时，稳态下每个时钟周期输出一个 beat（零气泡）。
4. `s_ready` 必须是寄存器直接输出（打断上游 ready 组合链——这是本模块存在的目的）。
5. `m_valid` / `m_data` 必须是寄存器直接输出。
6. 复位（同步高有效）后模块为空：`m_valid` 为 0，无残留数据；复位释放后正常工作。
7. 背压（`m_ready=0`）期间到达的 beat 不得丢失。

## 综合目标

- 器件 `xc7a100tcsg324-2`，时钟 400 MHz（2.5 ns），综合后 WNS ≥ 0。
- 无 latch，无组合环路。

## 自测

工作区 `sim/tb_smoke.sv` 提供一个最小连通性测试（顶层 `tb_smoke`），可用 ModelSim 自查：

```bash
vlib work && vlog -sv rtl/axis_skid_buffer.sv sim/tb_smoke.sv && vsim -c -onfinish stop work.tb_smoke -do "run -all; quit -f"
```

注意：smoke 测试只覆盖最基本场景，通过它不代表满足全部契约。判卷使用你不可见的完整测试与综合报告。
