# CHANGELOG — sdp_ram

## [1.0.0] — 2026-08-01 certified 认证

RTL 未改动；本条为 certified 转正所补的约束、证据与记账。

### 新增

- `constraints/sdp_ram.xdc`（250 MHz）；manifest 补 `device.part`、`params`
  （P_DWIDTH/P_AWIDTH）与资源预算（**事先按结构推算**：**BRAM 预期 1 片
  RAMB18E1** —— 512×32=16Kb 落在 18Kb 内，**实测若为 0 且 LUT 暴涨即推断失败
  属缺陷**；FF 52+1=53 取 80，`ro_rd_data` 预期被 BRAM 输出寄存器吸收）。
- `docs/limitations.md`（8 条）。
- TB 扩展：分场景计数与证据落盘；反假绿判据：任一 stability 子场景比较数为 0
  即判失败。

### 实测

- **641 次比对 0 失配**；参考为 TB 内建 golden 阵列（独立于 DUT 存储）
- **read-old 同址语义专项命中 18 次** —— TB 强制断言该场景至少命中一次，
  一次不命中即 `$fatal`（防止语义未被验证却判绿）
- 分场景：regression 133 / boundary 19 / stress 67 / backpressure 403
- 逐寄存器复位比对：7 个输入/输出寄存器 0 失配；**存储阵列按设计豁免**
  （BRAM 内容不可复位），豁免写入 `reset-sim.json` 的 `method` 字段
- 综合（OOC）：WNS +2.596ns @250MHz（约 **712 MHz**）；
  **BRAM 0.5 tile = 1 片 RAMB18E1，推断成功**；LUT 1/40，FF 53/80，DSP 0/0。
  **FF 实测 53 与结构推算 53 完全吻合**

### 认证记账

- G-SIGN-01：owner lihan 具名签署（证据复核 + 推断核对 + 6 组已接受限制）。
- gate-runner **20/20 全绿 CERTIFIED**；证据快照
  `evidence/sdp_ram/1.0.0/SNAPSHOT.json` 哈希锁定并 verify；迁入 `cbb/`。
- registry repin 1.0.0，maturity_status → certified。

## [0.1.0] — 2026-07-27 入库(批次 1, primitive 路径)

- 改写自 templates/comm/ram_2port.v:修端口前缀缺失、initial 初始化阵列(综合器
  静默忽略)、真双口双时钟同址写竞态、无复位;收敛为单时钟 1 写 1 读。
- TB: 643 次读比对 0 失配,含 18 次 read-old 同址碰撞定向检查。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
