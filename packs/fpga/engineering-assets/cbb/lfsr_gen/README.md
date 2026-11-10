<!-- asset-status: certified v1.0.1 -->
# lfsr_gen — 参数化 Fibonacci LFSR 伪随机序列发生器 (certified CBB)

扰码器/PRBS 测试序列/白噪声的库内标准原语。每个 `i_en` 拍产出一个序列字。

| 特性 | 值 |
|:--|:--|
| 延迟 | `i_en` 置位后 2 拍(输入寄存 + 输出寄存) |
| 序列 | 首字 = `P_SEED`,`next = {state[W-2:0], ^(state & P_POLY)}` |
| 周期 | 本原多项式下 `2^P_WIDTH - 1`(默认 16'hB400 → 65535) |
| 复位 | 同步高有效,回 `P_SEED` 重现完全相同序列(确定性) |
| 参数 | `P_WIDTH` / `P_POLY` / `P_SEED`(全 0 种子非法) |

**抽头约定**:`P_POLY[e-1]=1` ⇔ 多项式含 `x^e` 项;`P_POLY[P_WIDTH-1]`(x^W 项)必须为 1。
例:`7'h60 = x^7+x^6+1`(周期 127)。

## 与模板原件的关系

改写自 `skills/hdl-coding/templates/comm/lfsr_gen.sv`(v1.0.0)。原件**功能性错误**:
反馈掩码 `POLY[WIDTH-2:0]` 截掉 x^WIDTH 主抽头,序列与周期均不符标称;另有
valid/data 错一拍、`o_valid` 组合直出、死寄存器。缺陷逐条记录在 RTL 模块头。
修复后序列与旧模板**不兼容**(breaking——旧序列本身是错的)。

## 验证

`tb/tb_lfsr_gen.sv`(自检 TB,参考模型 = 软件式逐位异或行为级 LFSR,Vivado xsim 2023.1):
- 65546 字逐字比对 0 失配(随机使能气泡 + 连续满流)
- **16-bit 实测周期 65535、7-bit(x^7+x^6+1)实测周期 127**——周期是本原多项式
  的数学性质,直接暴露任何抽头错误(原模板的截位在此必炸)
- 运行中复位后序列从 SEED 重现,与首轮逐字一致

## 综合结论（OOC，xc7k325tffg900-2，Vivado 2023.1）

| 指标 | 预算 | 实测 | |
|:--|--:|--:|:--|
| WNS @ 4ns | ≥0 | **3.178 ns** | 达成约 1216 MHz，目标 250 MHz 裕量充足 |
| LUT | 40 | 2 | 4 抽头异或树 |
| FF | 60 | 26 | 低于结构推算 34，原因见下 |
| BRAM / DSP | 0 / 0 | 0 / 0 | 纯寄存+异或树，恒 0 |

**FF 26 而非 34 的原因**（已查明，非推断异常）：`ro_data[i]` 与 `r_lfsr[i+1]`
在同一使能下等价、可合并进移位链，但要求复位值匹配（`ro_data` 复位为 0）；
`P_SEED = 16'hACE1` 恰有 8 个位满足该条件，34 − 8 = 26，与实测吻合。

## 限制与验证边界

见 [`docs/limitations.md`](docs/limitations.md) —— 8 条，含参数约束（全 0 种子非法、
抽头位序约定）、非密码学安全、与旧模板序列不兼容、无反压接口、OOC 综合口径。

## 证据复现

```bash
cd engineering-assets

# 仿真证据 (reset-sim.json / tb-selfcheck.json / stability/*.json)
bash tools/run-primitive-sim.sh lfsr_gen --install

# 综合证据 (timing-summary.rpt / utilization.rpt)
node tools/pg-synth.cjs cbb/lfsr_gen

# 门禁判定
node tools/gate-runner.cjs cbb/lfsr_gen --repo-root ..
```

不带 `--install` 只跑不写入门禁目录，便于与既有证据比对。
2026-08-02 用该脚本复跑本包，产出的 6 份证据与 certified 时的记录**逐字节相同**。
