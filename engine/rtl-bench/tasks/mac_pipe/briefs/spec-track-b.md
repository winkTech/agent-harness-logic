# 验证任务：为 mac_pipe 编写自校验 Testbench

工作区 `rtl/mac_pipe.sv` 是一个 3 级流水有符号 MAC 实现。为它编写能严格验证以下契约的自校验 Testbench。

## 被测模块契约

接口：`clk`，`rst`（同步高有效），入侧 `s_valid/s_clr/s_a[15:0]/s_b[15:0]`（signed），出侧 `m_valid/m_acc[47:0]`（signed），无背压。

1. `s_clr=1` 的 beat：`acc = s_a*s_b`；`s_clr=0`：`acc = acc_prev + s_a*s_b`。有符号 16×16 乘、48 位累加。
2. 延迟恰好 3 拍，每个输入 beat 恰好产生一个输出 beat，`m_acc` 含当前 beat。
3. 输入气泡（`s_valid=0`）期间累加状态保持，不产生输出。
4. 复位后 `m_valid=0`、累加状态清零；释放后首 beat 从 0 开始累加。
5. `m_valid=1` 时 `m_acc` 无 X/Z。

## 交付物与判卷契约（必须遵守）

- 文件：`tb/tb_mac_pipe.sv`，顶层模块名 `tb_mac_pipe`，ModelSim 10.6 可编译运行。
- 结束时向 stdout 输出**恰好一行**判定：`RESULT: PASS` 或 `RESULT: FAIL`。
- 必须自带仿真超时看门狗；挂死不出结果按验证失败计。
- 只驱动/观测端口，不得探测 DUT 内部信号。

## 评分方式

你的 TB 会运行在：(1) 当前这份正确实现上——必须 `RESULT: PASS`，误报直接不通过；(2) 一组注入了不同真实缺陷的变体上——每检出一个计一分，检出率达标才通过。提示：契约的每一条都值得有对应的检查。
