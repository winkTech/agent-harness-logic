<!-- asset-status: certified v1.0.1 -->
# cdc_sync — 跨时钟域同步器 (单比特电平 / 多比特 req-ack 握手, certified CBB)

> **CDC 取证 (本资产核心)**: Vivado `report_cdc` **实跑** —— 10 条跨域路径,
> **0 Critical**; 2 条 CDC-3 Info (req/ack 各经 2 级 ASYNC_REG 同步链),
> 8 条 CDC-15 Warning (8 位数据总线的 clock-enable-controlled 结构, 四相握手的
> 预期形态)。**该 Warning 如实保留、不豁免、不声称 CDC clean** —— 其安全性由
> 协议而非结构承担, 论证逐条写在 `cdc-report.json`。
> **综合 (OOC)**: WNS +5.461ns @150MHz (dst); LUT 5/40, FF 24/80 (与推算吻合)。
> **自检**: 720 次比对 0 失配 (双向异频握手 700 字 + 单比特电平 20 次转变)。
> **限制**: 见 [`docs/limitations.md`](docs/limitations.md) —— 9 条, **第 1 条最
> 重要**: 亚稳态无法被仿真或综合报告证明; 另注意两域必须联合复位、高吞吐跨域
> 请改用异步 FIFO。

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

`tb/tb_cdc_sync.sv`(自检 TB,参考模型 = 发端 scoreboard 队列,Vivado xsim 2023.1):
- 双向异频(7.3ns↔10ns 非整数倍频比):快→慢 500 字 + 慢→快 200 字,
  **0 丢 0 重 0 乱序 0 X**,`o_valid_dst` 均为单拍脉冲
- 单比特电平:20 次慢速转变全部到达且有序
- 联合复位后恢复正常(在途字复位丢弃按契约扣账)

## 限制与验证边界 (limitations)

- 适用**单 bit 电平/脉冲跨域**;多 bit 总线跨域不适用(须格雷码或握手方案)。
- CDC 判定为结构扫描级,未经具名 CDC 工具;亚稳态本质不可仿真,MTBF 未计算。
- 双向异频实测为有限频比组合(700 字 0 丢 0 重),极端频比未穷举。
- **证据口径**:本包已 certified,综合时序/资源取证由 `pg-synth` 实跑并记入
  `envelope-check.json`;仿真证据由 **Vivado xsim 2023.1** 产出。全部结论均为
  **OOC 口径**(仅 `create_clock`,未布局布线、未绑引脚、未上板)。

## 证据复现

```bash
cd engineering-assets

# 仿真证据 (reset-sim.json / tb-selfcheck.json / stability/*.json)
bash tools/run-primitive-sim.sh cdc_sync --install

# 综合证据 (timing-summary.rpt / utilization.rpt)
node tools/pg-synth.cjs cbb/cdc_sync

# 门禁判定
node tools/gate-runner.cjs cbb/cdc_sync --repo-root ..
```

不带 `--install` 只跑不写入门禁目录，便于与既有证据比对。
2026-08-02 用该脚本复跑本包，产出的 6 份证据与 certified 时的记录**逐字节相同**。
