# cdc_sync — 跨时钟域同步器(单比特电平 / 多比特 req-ack 握手)

库内唯一受治理 CDC 原语(rules/01-hdl 定义了 `_cdc` 命名规范,此前库内无标准实现)。

| 特性 | 值 |
|:--|:--|
| P_DWIDTH=1 | N 级电平同步器,延迟 ≈ `P_STAGES+2` dst 拍;电平须保持 ≥2×P_STAGES dst 拍 |
| P_DWIDTH>1 | 四相 req/ack 握手;`i_valid_src && o_ready_src` 拍成交并锁数据,`o_valid_dst` 单拍脉冲 |
| 吞吐 | 握手往返约束——低速控制字/状态传递用;高吞吐跨域请用异步 FIFO(独立资产候选) |
| 复位 | 各域同步高有效;**两域须联合复位后再传输**,运行中单域复位不在契约内 |
| 参数 | `P_DWIDTH`(默认 8)/ `P_STAGES`(默认 2,最小 2) |

**元稳定性声明**:仿真只能证协议功能正确;结构安全性由 `(* ASYNC_REG *)` 属性 +
后端时序约束(set_max_delay / G-C-04 CDC 报告,certified 门)承担。

## 与模板原件的关系

改写自 `skills/hdl-coding/templates/comm/cdc_sync.sv`(v1.0.0)。原件五条缺陷:
`o_valid_dst` 组合直出且把复位当数据用、src 不锁数据("须保持稳定"全靠调用方自觉)、
无 `o_ready_src`(握手中新请求被静默丢弃)、同步链无 ASYNC_REG(安全性外包给使用者)、
跨域信号无 `_cdc` 命名。逐条修复记录在 RTL 模块头。

## 验证

`tb/tb_cdc_sync.sv`(自检 TB,参考模型 = 发端 scoreboard 队列,ModelSim):
- 双向异频(7.3ns↔10ns 非整数倍频比):快→慢 500 字 + 慢→快 200 字,
  **0 丢 0 重 0 乱序 0 X**,`o_valid_dst` 均为单拍脉冲
- 单比特电平:20 次慢速转变全部到达且有序
- 联合复位后恢复正常(在途字复位丢弃按契约扣账)
