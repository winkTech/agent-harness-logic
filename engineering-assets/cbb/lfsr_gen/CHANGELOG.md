# CHANGELOG — lfsr_gen

## [1.0.0] — 2026-08-01 certified 认证

RTL 未改动；本条为 certified 转正所补的约束、证据与记账。

### 新增

- `constraints/lfsr_gen.xdc`（250 MHz `create_clock`）；manifest 补
  `device.part = xc7k325tffg900-2`、`params`（P_WIDTH/P_POLY/P_SEED 及其理由）
  与资源预算（**事先按结构推算**：34 FF + 4 抽头异或树，留裕量取 FF 60 / LUT 40，
  BRAM/DSP 恒 0）。
- `docs/limitations.md`（8 条）。
- TB 扩展：新增 S3 边界场景（孤立单拍 `i_en` 脉冲 / 背靠背 2 拍 / 长断流 50 拍后
  恢复），并由 TB 自身 `$fwrite` 产出全部门禁证据（`tb-selfcheck.json` /
  `reset-sim.json` / `stability/*.json`），非人工填写。新增反假绿判据：每个
  stability 子场景比较数为 0 即判失败；收尾校验计数守恒与队列清空。

### 实测

- 自检：**65554 字逐字比对 0 失配**；16bit 周期 65535、7bit(x^7+x^6+1) 周期 127
- 分场景：regression 2444 / stress 63097 / boundary 8 / backpressure 65554
- 逐寄存器复位比对：8 个受复位寄存器 0 失配（无少复位豁免项）
- 综合（OOC）：WNS +3.178ns @250MHz（约 1216 MHz）；LUT 2/40，FF 26/60，
  BRAM 0/0，DSP 0/0。**FF 26 低于推算 34 已查明原因**：`ro_data[i]` 与
  `r_lfsr[i+1]` 同使能等价可合并、需复位值匹配，`P_SEED=16'hACE1` 恰 8 位满足，
  34−8=26，非推断异常。

### 认证记账

- G-SIGN-01：owner lihan 具名签署（证据复核清单 + 资源核对 + 7 组已接受限制）。
- gate-runner **20/20 全绿 CERTIFIED**；证据快照
  `evidence/lfsr_gen/1.0.0/SNAPSHOT.json` 哈希锁定并 verify；包迁入 `cbb/`。
- registry repin 1.0.0，maturity_status → certified。

## [0.1.0] — 2026-07-27 入库(批次 2, primitive 路径)

- 修反馈掩码截位丢主抽头功能错(原件序列错误);实测周期 65535(16 位)/127(7 位)
  作数学性质证据。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
