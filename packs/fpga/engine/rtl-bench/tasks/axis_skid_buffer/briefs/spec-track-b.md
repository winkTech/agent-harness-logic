# 验证任务：为 axis_skid_buffer 编写自校验 Testbench

工作区 `rtl/axis_skid_buffer.sv` 是一个 AXI-Stream 寄存切片（skid buffer）实现。为它编写一个能严格验证以下契约的自校验 Testbench。

## 被测模块契约

接口：`clk`，`rst`（同步高有效），入侧 `s_valid/s_ready/s_data[DATA_W-1:0]`，出侧 `m_valid/m_ready/m_data`，参数 `DATA_W`（默认 16）。

1. AXI-Stream 握手语义：`valid && ready` 上升沿成交；`m_valid` 置位后至握手前不得撤销，期间 `m_data` 保持不变。
2. 无丢失、无重复、无乱序（任意背压模式下）。
3. 满吞吐零气泡：`s_valid` 与 `m_ready` 恒为 1 时稳态每拍一个 beat。
4. 复位后为空、无残留输出；复位释放后恢复正常。

## 交付物与判卷契约（必须遵守）

- 文件：`tb/tb_axis_skid_buffer.sv`，顶层模块名 `tb_axis_skid_buffer`，ModelSim 10.6 可编译运行。
- 自校验：结束时向 stdout 输出**恰好一行**判定：`RESULT: PASS` 或 `RESULT: FAIL`（判卷解析此行）。
- 必须自带仿真超时看门狗（DUT 死锁时也要能输出 `RESULT: FAIL` 并结束）——挂死不出结果按验证失败计。
- 只驱动/观测上述端口，不得探测 DUT 内部信号（判卷时 TB 会被用于结构不同的实现）。
- TB 侧必须遵守 AXIS 主/从协议（如 `s_valid` 置位后保持到握手）。

## 评分方式

你的 TB 会被运行在：(1) 当前这份正确实现上——必须 `RESULT: PASS`，误报直接不通过；(2) 一组注入了不同真实缺陷的变体上——每检出一个（`RESULT: FAIL`）计一分。检出率达标才通过。缺陷类型不公开，按契约完备地验证即可。
