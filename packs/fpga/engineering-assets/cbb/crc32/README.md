<!-- asset-status: certified v1.0.1 -->
# crc32 — CRC-32 帧校验和 (IEEE 802.3 反射语义、字节流, certified CBB)

> **综合 (OOC, xc7k325tffg900-2)**: WNS +3.133ns @200MHz 即达成 **535 MHz**;
> LUT 64/140, FF 75/80 (与结构推算 75 完全吻合), BRAM 0/0, DSP 0/0。
> **自检**: 244 帧比对 0 失配, 含 IEEE 检验值 `'123456789' → 0xCBF43926` 硬锚。
> **限制**: 见 [`docs/limitations.md`](docs/limitations.md) —— 8 条, 重点是反射语义
> 与非反射变体不兼容、无 tready 反压接口、空帧无定义。

逐字节吸收帧数据,`i_last` 收尾后输出最终 FCS(已末尾取反)。

| 特性 | 值 |
|:--|:--|
| 语义 | init `0xFFFFFFFF`,LSB-first 反射多项式 `0xEDB88320`,末尾取反(标准检验值 `'123456789' → 0xCBF43926`,TB 硬锚) |
| 延迟 | `i_last` 后 2 拍 `o_valid` 单拍,`o_crc` 保持到下一帧尾 |
| 帧界 | 帧尾自动回 init,支持背靠背帧 |
| 吞吐 | 1 字节/拍 |
| 背压 | 无 tready;需要背压在上游例化 `axis_skid_buffer` |
| 复位 | 同步高有效 |

## 与模板原件的关系

改写自 `skills/hdl-coding/templates/internet/crc32.v`(v1.0.0)。原件**语义错配**:
声称以太网校验,实现却是非反射 MSB-first 且无末尾取反——按声称场景使用必然
校验失败(原件对 `'123456789'` 得 `0x0376E6E7`);且无帧界、无完成指示、
输入未寄存。逐条记录在 RTL 模块头。

## 验证

`tb/tb_crc32.sv`(自检 TB,参考模型 = 软件式逐位反射 CRC,Vivado xsim 2023.1):
**244 帧 0 失配**(regression 31 / boundary 4 / stress 200 / backpressure 8 + IEEE
检验值硬锚),含单字节帧、1500 字节长帧、背靠背帧、40% valid 气泡与满流一致性、
运行中复位后重算一致。

> 数字以 `var/gates/pg/crc32/tb-selfcheck.json` 为准,不在此处另抄一份。
> 此处原写 "36 帧" —— 那是 stress/backpressure 两个场景加入**之前**的旧数
> (31+4+1),TB 扩充后没跟着改,属手抄副本漂移。

## 限制与验证边界 (limitations)

- **语义锚定 IEEE 802.3 反射式 CRC32**;其他多项式/初值/变体不适用本模块。
- 字节流 valid/last 接口,**无 ready 背压契约**(库级约定:需要背压在外层组合 axis_skid_buffer)。
- 仅默认参数实测;硬锚覆盖标准检验值,随机帧对照 TB 内建逐位模型。
- **证据口径**:本包已 certified,综合时序/资源取证由 `pg-synth` 实跑并记入
  `envelope-check.json`;仿真证据由 **Vivado xsim 2023.1** 产出。全部结论均为
  **OOC 口径**(仅 `create_clock`,未布局布线、未绑引脚、未上板)。

## 证据复现

```bash
cd engineering-assets

# 仿真证据 (reset-sim.json / tb-selfcheck.json / stability/*.json)
bash tools/run-primitive-sim.sh crc32 --install

# 综合证据 (timing-summary.rpt / utilization.rpt)
node tools/pg-synth.cjs cbb/crc32

# 门禁判定
node tools/gate-runner.cjs cbb/crc32 --repo-root ..
```

不带 `--install` 只跑不写入门禁目录，便于与既有证据比对。
2026-08-02 用该脚本复跑本包，产出的 6 份证据与 certified 时的记录**逐字节相同**。
