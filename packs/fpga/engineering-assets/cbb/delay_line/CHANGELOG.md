# CHANGELOG — delay_line

## [1.0.1] — 2026-08-02 声明证据复现入口（G-GATE-02）

manifest 新增 `reproduce` 字段，把"证据怎么重做"从 README 里的散文变成**机器可校验
的契约**。新门 `G-GATE-02` 校验该命令引用的脚本在仓库中真实存在。

动因：`G-GATE-01` 只查证据文件在不在，普查发现 16 个 certified 里 14 个的证据当时
无法被任何人重新生成，**却全都通过了 G-GATE-01**。

RTL、约束、TB、证据零改动；升 patch 版仅因 manifest 内容变化会使快照的
`manifest_sha256` 失配，按库内既定做法升版重取。

## [1.0.0] — 2026-08-01 certified 认证

RTL 未改动；本条为 certified 转正所补的约束、证据与记账。

### 新增

- `constraints/delay_line.xdc`（250 MHz）；manifest 补 `device.part`、
  `params`（P_DWIDTH/P_DELAY）与资源预算（**事先按结构推算**：数据 2 级 × 32
  + valid 2 = 66 FF 取 80；**默认 P_DELAY=2 时 P_MID=0 无移位链，故 SRL 预期
  为 0，不能以 srl=0 判定推断失败**）。
- `docs/limitations.md`（8 条）。
- TB 扩展：分场景计数与证据落盘（由 TB 自身 `$fwrite` 产出）；反假绿判据：
  任一 stability 子场景比较数为 0 即判失败。

### 实测

- **9082 拍逐拍比对 0 失配**（`P_DELAY=2` 最小边界与 `P_DELAY=7` 含 5 级中间链
  两个例化并行验证）；计数守恒 in=out
- 分场景：regression 5991 / boundary 1037 / stress 2034 / backpressure 6540
- 逐寄存器复位比对：9 个 valid 链寄存器 0 失配。**数据链按设计豁免**
  （刻意不复位以利 SRL 推断），该豁免写入 `reset-sim.json` 的 `method` 字段，
  未静默略过
- 综合（OOC）：WNS +3.352ns @250MHz（约 **1543 MHz**）；LUT 1/40，
  FF 66/80，BRAM 0/0，DSP 0/0。**FF 实测 66 与结构推算 66 完全吻合**；
  SRL 实测 0 与预判一致

### 认证记账

- G-SIGN-01：owner lihan 具名签署（证据复核 + 资源核对 + 6 组已接受限制）。
- gate-runner **20/20 全绿 CERTIFIED**；证据快照
  `evidence/delay_line/1.0.0/SNAPSHOT.json` 哈希锁定并 verify；迁入 `cbb/`。
- registry repin 1.0.0，maturity_status → certified。

## [0.1.0] — 2026-07-27 入库(批次 2, primitive 路径)

- 合并取代 pipe_delay + delay_sync(裁决:定长延迟与背压正交分职,背压交
  axis_skid_buffer);自检 TB 对照队列参考模型。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
