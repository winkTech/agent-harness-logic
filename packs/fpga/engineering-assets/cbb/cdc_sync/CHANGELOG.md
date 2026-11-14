# CHANGELOG — cdc_sync

## [1.0.1] — 2026-08-02 声明证据复现入口（G-GATE-02）

manifest 新增 `reproduce` 字段，把"证据怎么重做"从 README 里的散文变成**机器可校验
的契约**。新门 `G-GATE-02` 校验该命令引用的脚本在仓库中真实存在。

动因：`G-GATE-01` 只查证据文件在不在，普查发现 16 个 certified 里 14 个的证据当时
无法被任何人重新生成，**却全都通过了 G-GATE-01**。

RTL、约束、TB、证据零改动；升 patch 版仅因 manifest 内容变化会使快照的
`manifest_sha256` 失配，按库内既定做法升版重取。

## [1.0.0] — 2026-08-01 certified 认证

RTL 未改动；本条为 certified 转正所补的约束、CDC 证据与记账。
**本模块是库内唯一的真实双时钟域资产**，CDC 取证路径与其余原语不同。

### 新增

- `constraints/cdc_sync.xdc` —— **双时钟约束**：src 100 MHz / dst 150 MHz
  （异频是刻意选择，同频会让跨域路径因偶然对齐而被误判为安全）；跨域路径用
  **`set_max_delay -datapath_only` 双向限界**而非
  `set_clock_groups -asynchronous`（后者会让工具完全忽略跨域路径，连数据通路
  延迟都不再约束）。
- manifest 补 `device.part`、`params`、资源预算（**事先按结构推算**：
  src 域 12 + dst 域 12 = 24 FF 取 80）与 `fmax_note`（说明单一 fmax 字段
  只能表达一个域）。
- `docs/limitations.md`（9 条）。
- TB 扩展：分场景计数、跨域逐寄存器复位审计（12 个含同步链）、证据落盘。

### CDC 取证（本版核心）

`report_cdc -details` **实跑**（pg-synth 不含该报告，另跑 Vivado 批处理），
取代 gate-runner 对单时钟域模块的结构扫描降级路径：

| ID | 严重度 | 条数 | 内容 |
|:--|:--|--:|:--|
| CDC-3 | Info | 2 | req/ack 各经 2 级 `(*ASYNC_REG*)` 同步链，标准安全结构 |
| CDC-15 | Warning | 8 | 8 位数据总线 clock-enable-controlled 结构 |
| — | **Critical** | **0** | |

10 条路径全部命中 `set_max_delay -datapath_only` 例外。

**8 条 CDC-15 Warning 如实保留、不做豁免、不声称 CDC clean** —— 数据总线刻意
不加同步器（加了反而会因各位收敛时刻不同而撕裂），安全性由四相握手协议承担，
论证逐条写进 `cdc-report.json`。

### 实测

- **720 次比对 0 失配**：A 快→慢 500 字 / B 慢→快 200 字（双向异频握手）
  + C 单比特电平 20 次转变；计数守恒不丢不重，`o_valid_dst` 均为单拍脉冲
- 分场景：regression 400 / boundary 20 / stress 300 / backpressure 700
  （**backpressure 是真实反压** —— 本模块有 `o_ready_src`，非等价判据）
- 跨域逐寄存器复位比对：12 个寄存器 0 失配（含同步链）
- 综合（OOC）：WNS +5.461ns @150MHz(dst)；LUT 5/40，FF 24/80，BRAM 0/0，DSP 0/0。
  **FF 实测 24 与结构推算 24 完全吻合**

### 认证记账

- G-SIGN-01：owner lihan 具名签署（证据复核 + CDC 取证 + 约束决策 + 6 组已接受
  限制，**第一条即「亚稳态无法被证明」**）。
- gate-runner **20/20 全绿 CERTIFIED**；证据快照
  `evidence/cdc_sync/1.0.0/SNAPSHOT.json` 哈希锁定并 verify；迁入 `cbb/`。
- registry repin 1.0.0，maturity_status → certified。

## [0.1.0] — 2026-07-27 入库(批次 2, primitive 路径)

- 修组合直出/丢数/无 ASYNC_REG 三缺陷;双向异频实测 700 字 0 丢 0 重。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
