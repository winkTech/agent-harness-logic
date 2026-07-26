# axis_skid_buffer — AXI4-Stream skid buffer(全寄存、满吞吐)

> 库级裁决的落地件:`docs/comm模块族认证差距清单.md` 指出 4/4 模块族存在
> tready/tvalid/tdata 组合直出(违反红线 2),裁决为"寄存 tready 的统一模式
> (skid buffer)后统一执行"。本模块即该统一模式的库内标准实现。

## 功能

打断 AXI-Stream 链路上的组合路径:上下游看到的 valid/ready/data/last
全部来自寄存器,同时保持每拍一次成交的满带宽。

| 特性 | 值 |
|:--|:--|
| 延迟 | 1 拍 |
| 吞吐 | 1 拍/beat(满带宽) |
| 复位 | 同步高有效 `i_rst`;释放后首拍 `s_axis_tready=0`,第 2 拍起为 1 |
| 参数 | `P_DWIDTH`(默认 32) |

## 与模板原件的关系

改写自 `skills/hdl-coding/templates/comm/axis_pipeline_reg.sv`(v1.0.0)。
原件 `o_tready` 组合穿通输入(违反红线 2)、无 tlast、全局停顿结构;
缺陷逐条记录在 RTL 模块头,原件保留不动作历史对照。

## 验证

`tb/tb_axis_skid_buffer.sv`(自检 TB,ModelSim):随机 valid/ready 压力 +
stall 稳定性检查(下游堵塞期间输出保持不变)。
最近一次:1914 beats 进出比对 0 失配,stall 稳定性检查 986 次,PASS。

## 使用约定

库内任何需要寄存 tready 的 AXI-Stream 出口,直接例化本模块,
不要各自手写 skid 逻辑(差距清单裁决:避免 4 个包各改各的)。
