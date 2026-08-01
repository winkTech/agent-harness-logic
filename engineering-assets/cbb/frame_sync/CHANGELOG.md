# CHANGELOG — frame_sync

## [1.0.0] — 2026-08-01 certified 认证

RTL 未改动；本条为 certified 转正所补的约束、证据与记账。

### 新增

- `constraints/frame_sync.xdc`（250 MHz）；manifest 补 `device.part`、
  `params`（P_MIN_PREAMBLE）与资源预算（**事先按结构推算**：
  ri_ 9 + 状态 3 one-hot + 前导计数 3 + ro_ 12 = 27 FF 取 40；FSM 次态与输出
  译码取 60 LUT）。
- `docs/limitations.md`（8 条）。
- TB 扩展：新增 100 帧浸泡场景与按帧索引区间归集的分场景计数；由 TB 自身
  `$fwrite` 产出全部门禁证据；反假绿判据：任一子场景比较字节数为 0 即判失败。

### 实测

- **124 帧 2476 字节比对 0 失配**；参考为 TB 侧按场景构造的期望帧序列
- **拒帧能力专项取证**：过短前导（`MIN_PRE-1` 个 0x55 + SFD）不得成帧、
  前导中掉载波不得成帧、假前导后同一载波内须能重新锁定 —— 三类均以
  「不得多出帧」判定。这正是原模板的致命缺陷所在（前导计数是死寄存器，
  单个 0x55+0xD5 即成帧，抗噪为零）
- payload **刻意含 0x55/0xD5** 字节，验证剥离只发生在帧头猎取阶段而非数据段
- 分场景字节：regression 322 / boundary 18 / stress 2136 / backpressure 2476
- 逐寄存器复位比对：9 个寄存器 0 失配（含 `r_cur_state` 复位值
  `P_ST_IDLE = 3'b001` one-hot）
- 综合（OOC）：WNS +2.403ns @250MHz（约 **626 MHz**）；LUT 19/60，FF 27/40，
  BRAM 0/0，DSP 0/0。**FF 实测 27 与结构推算 27 完全吻合**

### 认证记账

- G-SIGN-01：owner lihan 具名签署（证据复核 + 资源核对 + 拒帧能力取证 +
  6 组已接受限制）。
- gate-runner **20/20 全绿 CERTIFIED**；证据快照
  `evidence/frame_sync/1.0.0/SNAPSHOT.json` 哈希锁定并 verify；迁入 `cbb/`。
- registry repin 1.0.0，maturity_status → certified。

## [0.1.0] — 2026-07-27 入库(批次 3, primitive 路径)

- 修前导计数死寄存器/不透传/非三段式三缺陷;24 帧 350 字节实测,
  含短前导拒收与假前导重锁定向场景。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
