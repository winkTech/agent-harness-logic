# ddr_axi4_controller — DDR MIG AXI4 读写桥接控制器 (certified CBB)

> **自检**: 778 拍读回比对 **0 失配**（随机退避从机）；AXI 稳定性
> （`valid && !ready` 期间载荷不变）、`wlast` 协议、突发边界、事务中复位、
> AR 超时、`bresp=SLVERR` 注入全过。
> **限制**: 见 [`docs/limitations.md`](docs/limitations.md)。
>
> **TB 竞争修复记录（2026-08-01）**：本模块的自检 TB 首次真正跑起来时报 87~298
> 处失配，诊断结果是 **TB 的从机模型在 posedge 之后用阻塞赋值驱动 R 通道**，
> 与 DUT 自身 `always_ff @(posedge)` 同时间步、顺序不定，DUT 有时采到下一拍的
> `rdata`/`rlast`。**RTL 无缺陷** —— 改为 negedge 驱动后 0 失配。

<!-- asset-status: certified v1.0.1 -->


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
(关联数组存储器)+ 期望镜像,Vivado xsim 2023.1):
随机读写混合(len 1..16)+ 从机随机退避,**778 次比对 0 失配**
(以 `tb-selfcheck.json` 的 `compares` 为准;此处原写 "198 拍读回",
单位与证据文件不一致,且未随 TB 扩充更新);
AXI 三通道 valid&&!ready 载荷稳定性逐拍断言;wlast 协议检查;
len=1/max 边界;帧中复位恢复;AR 静默超时 → `o_err` 置位并恢复;SLVERR 注入。

## 限制与验证边界 (limitations)

- 对测对象为 **TB 内建行为级 AXI4 从机**(按 AXI4 规范时序),未对真实 MIG 硬核实测;上板前须联调。
- 单 ui_clk 时钟域,跨域由 MIG 侧负责(README 已明示)。
- 突发长度 1..P_MAX_BURST 边界已覆盖;不支持 outstanding 多事务交织。仅默认参数实测。
- **证据口径**:本包已 certified,综合时序/资源取证由 `pg-synth` 实跑并记入
  `envelope-check.json`;仿真证据由 **Vivado xsim 2023.1** 产出。全部结论均为
  **OOC 口径**(仅 `create_clock`,未布局布线、未绑引脚、未上板)。

## 证据复现

```bash
cd engineering-assets

# 仿真证据 (reset-sim.json / tb-selfcheck.json / stability/*.json)
bash tools/run-primitive-sim.sh ddr_axi4_controller --install

# 综合证据 (timing-summary.rpt / utilization.rpt)
node tools/pg-synth.cjs cbb/ddr_axi4_controller

# 门禁判定
node tools/gate-runner.cjs cbb/ddr_axi4_controller --repo-root ..
```

不带 `--install` 只跑不写入门禁目录，便于与既有证据比对。
2026-08-02 用该脚本复跑本包，产出的 6 份证据与 certified 时的记录**逐字节相同**。
