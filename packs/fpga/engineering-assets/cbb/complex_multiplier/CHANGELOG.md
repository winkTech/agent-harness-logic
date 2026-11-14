# CHANGELOG — complex_multiplier

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

- `constraints/complex_multiplier.xdc`（250 MHz）；manifest 补 `device.part`、
  `params`（P_A_W/P_B_W 及理由）与资源预算（**事先按结构推算**：
  **DSP 必为 4** —— 四乘法直算，16×16 落在 DSP48E1 的 25×18 内，每乘法独占
  一片，**实测若为 0 即推断失败属缺陷**；FF 名义 260 但乘积级与加减级可被
  DSP48 内部寄存器与后加器吸收，预算取 200；LUT 取 120）。
- `docs/limitations.md`（8 条）。
- TB 扩展：新增 C6 五千拍浸泡阶段与分场景计数；由 TB 自身 `$fwrite` 产出全部
  门禁证据；新增反假绿判据：任一 stability 子场景有效拍数为 0 即判失败。

### 实测

- 自检：**7357 有效拍逐拍比对 0 失配**（另检 8142 个时钟拍的 `o_valid` 对齐）
- 分场景：boundary 12（定向极值，含 `C_MIN×C_MIN = 2^30` 补码边界）/
  regression 2000 / stress 5000 / backpressure 245
- 逐寄存器复位比对：13 个流水寄存器 0 失配
- 综合（OOC）：WNS +2.51ns @250MHz（约 **671 MHz**）；**DSP 4/4**，
  LUT 0/120，FF 3/200，BRAM 0/0

**LUT 0 / FF 3 已核对为 DSP48E1 完美吸收**（输入寄存→A/B 寄存器、乘积→M
寄存器、加减→后加器与 P 寄存器级联），fabric 侧只剩 3 拍 valid 链
（`ri_valid`/`r_valid_m`/`ro_valid`），与设计意图逐项对应 —— 不是逻辑被优化掉。

### 认证记账

- G-SIGN-01：owner lihan 具名签署（证据复核 + 推断核对 + 6 组已接受限制）。
- gate-runner **20/20 全绿 CERTIFIED**；证据快照
  `evidence/complex_multiplier/1.0.0/SNAPSHOT.json` 哈希锁定并 verify；迁入 `cbb/`。
- registry repin 1.0.0，maturity_status → certified。

## [0.1.0] — 2026-07-27 入库(批次 1, primitive 路径)

- 改写自 templates/comm/cmult.sv:原件四条独立功能缺陷(复数乘法公式错/操作数
  张冠李戴/死寄存器/流水错拍+输入直通);弃三乘法结构改四乘法直算。
- TB: 3138 拍比对(2357 有效拍)0 失配,实测延迟 3 拍。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
