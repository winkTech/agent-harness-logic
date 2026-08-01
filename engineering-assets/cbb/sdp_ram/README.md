<!-- asset-status: certified v1.0.0 -->
# sdp_ram — 简单双端口同步 RAM (1 写 + 1 读、单时钟, certified CBB)

> **综合 (OOC, xc7k325tffg900-2)**: WNS +2.596ns @250MHz 即达成约 **712 MHz**;
> **BRAM 0.5/1 tile = 1 片 RAMB18E1, 推断成功** (512x32=16Kb 落在 18Kb 内);
> LUT 1/40, FF 53/80 (与推算完全吻合, ro_rd_data 被 BRAM 输出寄存器吸收), DSP 0/0。
> **自检**: 641 次比对 0 失配, **read-old 同址语义专项命中 18 次**。
> **限制**: 见 [`docs/limitations.md`](docs/limitations.md) —— 8 条, 重点是
> **read-old 语义** (需要 read-new 的不能直接用) 与 **阵列不复位、上电为 X**
> (须先写后读)。

参数化位宽/深度的存储阵列,面向 BRAM 推断:写口无回读,读口同步读。

| 特性 | 值 |
|:--|:--|
| 延迟 | 2 拍(输入寄存 1 + 阵列同步读 1),`o_rd_valid` 与数据同拍 |
| 同址语义 | 同拍写读同地址 → 读端得**旧值**(read-old),由非阻塞赋值语义保证 |
| 复位 | 同步高有效 `i_rst`;**阵列不复位**(强行复位会阻止 BRAM 推断),上电内容为 X,调用方须先写后读 |
| 参数 | `P_DWIDTH`(默认 32)/ `P_AWIDTH`(默认 9,深度 2^9) |

## 与模板原件的关系

改写自 `skills/hdl-coding/templates/comm/ram_2port.v`(v1.0.0)。
原件缺陷:端口无 i_/o_ 前缀、initial 初始化阵列(综合器忽略,与 ldpc
h_matrix_addr 被 Vivado 丢弃属同一类坑)、真双口双时钟同址写竞态、无复位。
逐条修复记录在 RTL 模块头;收敛为单时钟 1 写 1 读,消除未定义行为。

## 验证

`tb/tb_sdp_ram.sv`(自检 TB,参考模型 = TB 内关联数组,ModelSim):
随机读写 + 定向同址写读碰撞。
最近一次:643 次读比对 0 失配,其中 read-old 同址碰撞检查 18 次,PASS。

## 限制与验证边界 (limitations)

- 同址语义 **read-old**,依赖非阻塞赋值与 BRAM 推断模式的一致性;跨器件族未逐一验证。
- **阵列不复位**(保 BRAM 推断),上电内容 X,调用方必须先写后读。
- 单时钟 1 写 1 读;真双口/双时钟场景不适用。仅默认 32×512 实测。
- **qualification 级证据边界**:自检 TB 功能验证已实跑,无综合时序/资源取证(certified 转正时按 pg-synth 流程补)。
