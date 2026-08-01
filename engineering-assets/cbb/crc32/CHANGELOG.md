# CHANGELOG — crc32

## [1.0.0] — 2026-08-01 certified 认证

RTL 未改动；本条为 certified 转正所补的约束、证据与记账。

### 新增

- `constraints/crc32.xdc`（200 MHz `create_clock`；目标低于 `lfsr_gen` 的
  250 MHz —— 关键路径是单拍内 8 步反射展开的异或树，比单次归约深）；manifest 补
  `device.part` 与资源预算（**事先按结构推算**：32+8+2+32+1 = 75 FF 取 80；
  8 步展开后 32 位异或树约 32 个 LUT6 量级，取 140；BRAM/DSP 恒 0）。
- `docs/limitations.md`（8 条）。
- TB 扩展：新增 backpressure 等价场景（同一帧分别以满流与 60% 气泡供流，结果须
  逐位相同）与 200 帧浸泡；由 TB 自身 `$fwrite` 产出全部门禁证据，非人工填写；
  新增反假绿判据：任一 stability 子场景比较数为 0 即判失败。

### 实测

- 自检：**244 帧比对 0 失配**，含 IEEE 802.3 检验值 `'123456789' → 0xCBF43926`
  硬锚（该锚不依赖参考模型，直接钉死反射语义）
- 分场景：regression 31 / boundary 4 / stress 200 / backpressure 8
- 逐寄存器复位比对：6 个受复位寄存器 0 失配（含 `r_crc` 复位值 `0xFFFFFFFF`）
- 综合（OOC）：WNS +3.133ns @200MHz（**535 MHz**）；LUT 64/140，FF 75/80，
  BRAM 0/0，DSP 0/0。**FF 实测 75 与结构推算 75 完全吻合**

### 认证记账

- G-SIGN-01：owner lihan 具名签署（证据复核 + 资源核对 + 6 组已接受限制）。
- gate-runner **20/20 全绿 CERTIFIED**；证据快照
  `evidence/crc32/1.0.0/SNAPSHOT.json` 哈希锁定并 verify；包迁入 `cbb/`。
- registry repin 1.0.0，maturity_status → certified。

## [0.1.0] — 2026-07-27 入库(批次 3, primitive 路径)

- 修语义错配:原件非反射 MSB-first 无终值取反,按声称的以太网场景必然失败;
  重写为 IEEE 802.3 反射式(init 0xFFFFFFFF/输入输出反射/终值取反)。
- TB: 36 帧含 IEEE 检验值硬锚 '123456789'→0xCBF43926 + TB 内建软件式逐位模型对照;
  单字节帧/长帧/背靠背帧/复位后首帧一致性实测。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
