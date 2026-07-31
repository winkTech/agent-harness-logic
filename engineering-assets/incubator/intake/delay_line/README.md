# delay_line — 定长流水延迟线(valid 标记、无背压)

流水对齐的基础原语:`o_valid/o_data` 是 `i_valid/i_data` 精确延迟 `P_DELAY` 拍的副本。

| 特性 | 值 |
|:--|:--|
| 延迟 | 恒等于 `P_DELAY` 拍(最小 2:输入/输出寄存各占一级,红线 1/2) |
| 吞吐 | 1 拍/beat,自由流水 |
| 背压 | 无 tready(与 complex_multiplier 同约定);需要背压在输出侧例化 `axis_skid_buffer` |
| 复位 | 同步高有效;**valid 链清零,数据链不复位**(省复位扇出、利于 SRL 推断);在途 beat 复位丢弃属契约行为 |
| 参数 | `P_DWIDTH`(默认 32)/ `P_DELAY`(默认 2) |

## 与模板原件的关系

**合并取代两件**(裁决:定长延迟与背压是正交职责,分别由本模块与 axis_skid_buffer 承担):
- `skills/hdl-coding/templates/comm/pipe_delay.sv`:`o_ready` 组合穿通 `i_ready`(违反红线 2,与
  axis_pipeline_reg 同类)、全局停顿结构、stage0 valid 清除条件错、复位清数据链阻 SRL
- `skills/hdl-coding/templates/comm/delay_sync.v`:端口无 i_/o_ 前缀、无 valid 语义

缺陷逐条记录在 RTL 模块头。

## 验证

`tb/tb_delay_line.sv`(自检 TB,参考模型 = SV 队列,ModelSim):
- P_DELAY=2(最小)与 P_DELAY=7 双例化,共 9082 拍逐拍比对 0 失配
- 随机气泡流 + 连续满流,valid 计数守恒(复位丢弃的在途 beat 按契约扣账)
- 运行中复位后 P_DELAY 拍内 o_valid 无残留,恢复正常

## 限制与验证边界 (limitations)

- **定长延迟,无背压契约**(库级裁决:与 axis_skid_buffer 正交分职)。
- 仅默认参数实测;SRL 推断未做综合取证。
- **qualification 级证据边界**:自检 TB 功能验证已实跑,无综合时序/资源取证(certified 转正时按 pg-synth 流程补)。
