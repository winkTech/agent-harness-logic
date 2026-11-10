# 修缮任务：axis_skid_buffer 资源超预算

工作区 `rtl/axis_skid_buffer.sv` 是一个历史遗留的 AXI-Stream 寄存切片实现：功能正确，但当年为"时序保险"串接了 4 级寄存切片，资源约为合理实现的 4 倍。`reports/flow_summary.json` 是它当前的 OOC 综合报告（vivado-flow 产出）。

## 目标

在**不改变接口与外部行为**的前提下重构该模块，使 OOC 综合（器件 `xc7a100tcsg324-2`，时钟 2.5 ns）满足：

| 指标 | 预算 |
|:-----|:-----|
| WNS | ≥ 0 |
| FF | ≤ 48 |
| LUT | ≤ 32 |

## 必须保持的行为契约

1. 接口不变：`clk`、`rst`（同步高有效）、`s_valid/s_ready/s_data[DATA_W-1:0]`、`m_valid/m_ready/m_data`，参数 `DATA_W` 默认 16。
2. AXI-Stream 握手语义；`m_valid` 置位后至握手前不撤销，`m_data` 保持。
3. 无丢失、无重复、无乱序；满吞吐零气泡。
4. `s_ready` 与 `m_valid/m_data` 仍必须是寄存器直接输出（不得用组合直通换资源）。
5. 复位后为空；复位释放后恢复正常。

延迟（beat 穿越模块的拍数）允许改变——它不是契约的一部分。

## 交付与判卷

- 交付物：修改后的 `rtl/axis_skid_buffer.sv`（顶层模块名不变）。
- 判卷：先跑你不可见的功能回归（含背压/复位/吞吐场景），功能不倒退是硬门；再跑 OOC 综合比对上表预算。两者都过才通过。
- 有 Vivado 环境时建议自行跑 OOC 综合确认预算后再交付；结论以 `flow_summary.json` 数字为准。
