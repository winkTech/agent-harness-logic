# CBB 候选台账 — skills/hdl-coding 散落 RTL 归集处置

> 覆盖 `skills/hdl-coding/` 下全部 22 个散落 RTL 文件(20 模板 + 2 验证参考)。
> 处置原则:通用件复制改造入 `incubator/intake`(源模板只读保留作历史对照,
> 已加溯源警示头);验证支撑件原地保留;其余入台账待裁决。
> 批次 1(2026-07-26)与批次 2(2026-07-27)共完成 7 件模板 → 6 个受治理
> CBB 包,验证证据见各包 TB 与 `var/gates/pg/<asset>/`。
> 本文件是批次 1 需求门禁 scope 承诺的台账,批次 2 补落盘。

## 已入库(7 件模板 → 6 个 intake 包)

| 源模板 | 去向 | 原件核心缺陷 | 验证证据(ModelSim 自检 TB) |
|:--|:--|:--|:--|
| comm/ram_2port.v | `intake/sdp_ram` | 无前缀命名;initial 初始化阵列(综合器忽略);真双口双时钟同址写竞态;无复位 | 643 读 0 失配,含 18 次 read-old 同址碰撞 |
| comm/axis_pipeline_reg.sv | `intake/axis_skid_buffer` | o_tready 组合穿通输入(红线 2);无 tlast;全局停顿结构 | 1914 beats 0 失配 + 986 次 stall 稳定性 |
| comm/cmult.sv | `intake/complex_multiplier` | **功能错**:复乘公式错(re=ac+bd)/操作数错拍/死寄存器/输入直通 | 2357 有效拍 0 失配,延迟 3 |
| comm/lfsr_gen.sv | `intake/lfsr_gen` | **功能错**:反馈掩码截位丢 x^WIDTH 主抽头;valid/data 错拍;组合直出 | 65546 字 0 失配;实测周期 65535/127 |
| comm/pipe_delay.sv | `intake/delay_line`(合并) | o_ready 组合穿通;全局停顿;复位清数据链阻 SRL | 双例化 9082 拍 0 失配,复位无残留 |
| comm/delay_sync.v | `intake/delay_line`(合并) | 无前缀命名;无 valid 语义 | 同上 |
| comm/cdc_sync.sv | `intake/cdc_sync` | o_valid_dst 组合直出混复位;src 不锁数据;无 ready(静默丢数);无 ASYNC_REG/_cdc | 双向异频 700 字 0 丢 0 重;电平 20 转变有序 |

裁决记录:
- 定长延迟与背压为正交职责,分别由 `delay_line` 与 `axis_skid_buffer` 承担,
  不再提供带 ready 的延迟线。
- `lfsr_gen` 修反馈后序列与旧模板不兼容(breaking——旧序列本身是错的)。
- 多时钟资产的 manifest 承载:schema 已加可选 `clocks/resets` 数组,
  单数 `clock/reset` 指主域(dst)。

## 验证支撑件(原地保留,非 CBB 候选)

| 文件 | 定位 |
|:--|:--|
| references/axi-stream-vip.sv | AXI-Stream 验证 IP(TB 激励/检查),供 TB 复用 |
| references/axi_stream_if.sv | AXI-Stream interface 定义,供 SV TB 复用 |
| templates/comm/axis_master.sv / axis_slave.sv | TB 激励/收集器(行为级构造),非可综合资产 |

## 待裁决(11 件,未入库)

**alu/(3 件)** — alu_16bit_7func.v / alu_4bit_16func.v / carry_lookahead_4bit.v:
纯组合无时钟,入库须按红线 1/2 加流水包壳,属架构决策(教学参考价值 vs
通用复用价值待 owner 定夺)。

**internet/(8 件)** — cam_cell / crc.sv / crc32 / crossbar_cell / frame_sync /
hash_table / lru_counter / sm4_round:外部资料改编的协议专用件,命名全不合规,
通用性逐个裁决。crc32/frame_sync 通用价值较高,建议下批优先;
sm4_round 涉及密码算法正确性,须先建 golden 再入库。

## 遗留

- ~~6 个原语包统一卡 G-B-02~~ **已裁决(owner,2026-07-27)**:golden model
  锚的是**算法**,不是所有模块。结构原语 `kind=primitive` 的正确性锚 =
  自检 TB(G-B-02),certified 级 G-B-03 = 自检 TB 实跑证据落盘
  (`tb-selfcheck.json`)。裁决已入治理规范 §2.6 修订记录、schema 与
  gate-runner;6 包全部达 **QUALIFICATION**。
- 原语 certified 待办:TB 运行脚本导出 `tb-selfcheck.json` 证据 +
  Vivado 综合门(G-C-01/02)+ 签字。
- ldpc llr_buffer/msg_buffer 换用 sdp_ram 属后续独立任务(避免扰动 ldpc
  转正路径)。
