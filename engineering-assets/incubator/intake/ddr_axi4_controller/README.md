# ddr_axi4_controller — DDR MIG AXI4 读写桥接控制器

用户命令/数据流接口与 Xilinx MIG(AXI4 slave)之间的桥接层。单 ID、单事务顺序执行。

| 特性 | 值 |
|:--|:--|
| 命令 | `i_cmd_valid/o_cmd_ready` + write/addr/len(拍数 1..`P_MAX_LEN`) |
| 写数据 | `i_wr_*` 数据流(valid/ready),内联 skid 满吞吐,AXI 载荷握手期稳定 |
| 读数据 | `o_rd_*` 寄存转发,无背压(需背压下游接 `axis_skid_buffer`) |
| 错误 | `o_err` 粘滞 = 超时(`P_TIMEOUT` 拍无进展)/bresp/rresp 错;下一命令成交自动清 |
| 复位 | 同步高有效;复位丢弃在途事务——**须系统级复位**(仅复位本模块会与从机协议上下文失步) |
| 时钟 | 单时钟(= MIG `ui_clk` 域);跨域由 MIG 侧负责 |
| 参数 | `P_DATA_W/P_ADDR_W/P_ID_W/P_MAX_LEN/P_TIMEOUT` |

**超时语义**:看门狗超时会撤 AXI valid 并回 IDLE——严格 AXI 不允许撤 valid,
该路径仅作为 MIG 挂死后的恢复手段,README 与模块头均明示。
**验证边界**:TB 行为级 AXI4 从机只证协议时序正确性,不证 DDR 训练/刷新时序;
certified 级需上板证据。

## 与原件的关系

改写自 `knowledge/primary/domains/fpga/ddr_axi4_controller.sv`(参考设计,357 行)。
原件七条缺陷(架构级:写通路无数据流接口;协议级:awlen/wlast 拍数语义矛盾;
红线 1/2/3/5;超时静默;`cmd_write_nread` 命名与语义相反)逐条记录在 RTL 模块头。

## 验证

`tb/tb_ddr_axi4_controller.sv`(自检 TB,参考模型 = 行为级 AXI4 从机
(关联数组存储器)+ 期望镜像,ModelSim):
随机读写混合(len 1..16)+ 从机随机退避,**198 拍读回 0 失配**;
AXI 三通道 valid&&!ready 载荷稳定性逐拍断言;wlast 协议检查;
len=1/max 边界;帧中复位恢复;AR 静默超时 → `o_err` 置位并恢复;SLVERR 注入。
