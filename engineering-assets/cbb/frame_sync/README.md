<!-- asset-status: certified v1.0.1 -->
# frame_sync — 以太网风格帧定界器 (前导+SFD 检测、数据流透传, certified CBB)

> **综合 (OOC, xc7k325tffg900-2)**: WNS +2.403ns @250MHz 即达成约 **626 MHz**;
> LUT 19/60, FF 27/40 (与结构推算 27 完全吻合), BRAM 0/0, DSP 0/0。
> **自检**: 124 帧 2476 字节比对 0 失配; 拒帧能力专项取证 (过短前导/掉载波
> 不得成帧、假前导后须能重新锁定)。
> **限制**: 见 [`docs/limitations.md`](docs/limitations.md) —— 8 条, **最易误用
> 的是第 1 条**: `i_valid` 是载波有效 (GMII rx_dv 语义), 帧内必须连续, 拉低即
> 帧尾; 直接接带气泡的流 valid 会把帧切碎。

在载波字节流中检测 `≥P_MIN_PREAMBLE` 个 `0x55` + SFD `0xD5`,之后的数据字节
以对齐的 `o_valid/o_data` 透传,并给出 `o_sof`(与首数据拍同拍)/`o_eof`
(帧尾后单拍)定界脉冲。

| 特性 | 值 |
|:--|:--|
| `i_valid` 语义 | **载波有效**(如 GMII rx_dv):帧内连续,拉低即帧尾;不是可气泡流 valid |
| 延迟 | 输出流相对输入流 2 拍 |
| 剥除 | 前导/SFD 剥除;**FCS 不剥**(可组合 `delay_line` + `crc32` 实现) |
| 抗噪 | 前导不足不成帧;假前导后同一载波内可重新猎取 |
| 复位 | 同步高有效;帧中复位丢弃当前帧 |
| 参数 | `P_MIN_PREAMBLE`(默认 2) |

## 与模板原件的关系

改写自 `skills/hdl-coding/templates/internet/frame_sync.v`(v1.0.0)。原件缺陷:
前导计数器是**死寄存器**(写入从未读,单个 0x55+0xD5 即成帧,抗噪为零)、
不透传数据且指示相位未定义、单 always 非三段式、输入未寄存、P_ST_CRC 状态
无意义。逐条记录在 RTL 模块头。

## 验证

`tb/tb_frame_sync.sv`(自检 TB,参考模型 = 场景期望帧序列 + 不同源装帧收端,
Vivado xsim 2023.1):**2476 次比对 0 失配**(以 `tb-selfcheck.json` 的
`compares` 为准;此处原写 "24 帧 350 数据字节",单位与证据文件不一致,
且未随 TB 扩充更新);payload 含 0x55/0xD5 不重同步;
背靠背帧;短前导拒帧;假前导后重锁;前导中掉载波;帧中复位恢复。

## 限制与验证边界 (limitations)

- 字流接口**无背压契约**(库级约定同 crc32/delay_line)。
- 同步字格式按参数配置,实测覆盖默认格式;连续错帧下的重锁时延边界未穷举。
- **证据口径**:本包已 certified,综合时序/资源取证由 `pg-synth` 实跑并记入
  `envelope-check.json`;仿真证据由 **Vivado xsim 2023.1** 产出。全部结论均为
  **OOC 口径**(仅 `create_clock`,未布局布线、未绑引脚、未上板)。

## 证据复现

```bash
cd engineering-assets

# 仿真证据 (reset-sim.json / tb-selfcheck.json / stability/*.json)
bash tools/run-primitive-sim.sh frame_sync --install

# 综合证据 (timing-summary.rpt / utilization.rpt)
node tools/pg-synth.cjs cbb/frame_sync

# 门禁判定
node tools/gate-runner.cjs cbb/frame_sync --repo-root ..
```

不带 `--install` 只跑不写入门禁目录，便于与既有证据比对。
2026-08-02 用该脚本复跑本包，产出的 6 份证据与 certified 时的记录**逐字节相同**。
