# mod_demapper — 软判决解调 (max-log LLR), Q(10,4) 串行输出

| | |
|---|---|
| 版本 | **1.0.0** |
| 成熟度 | intake（22 道门中 21 过，缺 owner 签字） |
| 位真基准 | `engineering-assets/models/comm/ofdm/src/rtl_mirror_demap.m`，**0 容差** |
| 器件 / 时钟 | xc7k325tffg900-2 / 100 MHz 单域 |

把 `eq_zf` 均衡后的符号变成 LDPC 译码器吃得下的软信息。上游 `eq_zf` 1.1.0 的
`m_axis_tdata` + `o_conf` + `o_erasure` 直接对接，下游是 `cbb/ldpc_codec`。

## 1. 接口

| 端口 | 方向 | 位宽 | 说明 |
|---|---|---|---|
| `i_clk` / `i_rst` | in | 1 | 同步高有效复位 |
| `i_mod` | in | 2 | 0=QPSK 1=16QAM 2=64QAM |
| `s_axis_tvalid/tready/tdata` | — | 32 | `{im, re}`，Q4.12，与 `eq_zf` 同字序 |
| `i_conf` | in | 12 | `{sh[5:0], man[5:0]}`，即 \|H\|² 的浮点压缩 |
| `i_erasure` | in | 1 | `eq_zf` 的 \|H\|²=0 标记（裁定④） |
| `m_axis_tvalid/tready/tdata` | — | 10 | Q(10,4)，**每拍一个 LLR**，b0 在前 |
| `m_axis_tlast` | out | 1 | 该符号最后一个比特 |

**符号约定**：正 LLR = 该比特更可能是 **0**。这随下游 `ldpc_codec` 的 `s=1-2c`，与发端
`mod_mapper` 的 `s=2b-1` 方向相反。搞错这个号译码器会整体失效，而现象看着像"译码器不
工作"而不是"符号反了"。

## 2. 结构

```
s_axis ─ ri_ ─┬─ demap_metric (I 轴)  延迟 5 ─┐
              └─ demap_metric (Q 轴)  延迟 5 ─┴─ 保持寄存器 ─ 串行化 FSM
                                                     └─ demap_scale 延迟 5 ─ 出侧 FIFO ─ m_axis
```

**8 槽位统一化**：三档共用一条数据通路。QPSK 每电平复制 4 份、16QAM 复制 2 份，复制不
改变 min 的结果，换来的是**比特掩码与调制无关**（`b0=8'hF0 / b1=8'h3C / b2=8'h66`）。
Gray 标号在三档之间是嵌套的——这是从 `mod_mapper` 枚举**查出来的**，不是凑的。推论：
QPSK 的 `m1/m2` 与 16QAM 的 `m2` 恒为 0，上层无须按调制屏蔽。

**metric 流水与串行化重叠**：见 §4 吞吐。

## 3. 正确性依据

判卷 **0 容差**，期望值来自治理侧定点镜像而非浮点直接量化——镜像与 RTL 走同一条整数
路径，任何差异都是缺陷而不是噪声。浮点锚 `mod_demapper_llr` 的角色在上一层：它锁镜像
本身（`test_rtl_mirror_demap` 的 T1，差须落在 Q(10,4) 的 1 LSB 量化地板内），不参与判卷。

| 调制 | K | 点数 | LLR 数 | 失配 |
|---|---|---|---|---|
| QPSK | 2 | 2304 | 4608 | **0** |
| 16QAM | 16 | 2304 | 9216 | **0** |
| 64QAM | 32 | 2304 | 13824 | **0** |

子模块的参考模型**刻意与 DUT 结构不同**，否则测的只是"同一段代码写了两遍"：
`tb_demap_metric` 用循环式 min 对硬连的 4 路树；`tb_demap_scale` 用 96 位全精度式子对
`sh'≥48 恒 0` 的捷径。

每个常数的实测出处：
- 轴分解 → `analysis/demap_axis_check.m`（前提"比特标号也按轴划分"是**查**出来的）
- 标度 K → `analysis/demap_e2e_ber.m`（判据是**端到端 BER**，代理指标定不了）
- conf 位宽 → `analysis/demap_fixed_point_study.m`
- 位宽/舍入/饱和 → `analysis/demap_fp_proto.m`

## 4. 吞吐——它是**接口形状的依据**，不是附带指标

```
OFDM 符号 = 80 样点 @20 MHz = 4 µs = 100 MHz 下 400 拍
64QAM 每符号 48 × 6 = 288 个 LLR  <  400        → 串行输出成立
```

**若按 20 MHz 时钟算，288 > 80，串行根本走不通，必须并出 bps 个。** 这笔账要在写 RTL
之前算，所以它是一条判据（`tb_mod_demapper` 的 T8）而不是设计注释里的一次心算。

"算完再串行"是 `5 + bps = 11` 拍/点，48 点需 528 拍 > 400——**持续速率不够，不是突发
问题，加输入 FIFO 也救不了**。故在串行化期间就把下一点打进 metric 流水，实测 **6.9
拍/点**（预算 8.33，余量 17%）。

## 5. 已知边界与限制（集成方必须落实）

**① 不支持 BPSK，显式报错（D-DEMAP-01）。** 802.11a 的 6/9 Mbps 用 BPSK，所以这是对
Clause 17 的**真实覆盖缺口**，不是"暂未实现"。原因是标度 K 只对三档做过端到端 BER
实测；不凭"跟 QPSK 差不多"填一个数——错的标度在链路上只表现为"BER 略差"，不会被任何
一条判据抓住。补齐需一轮端到端 BER + owner 裁定。

**② `i_mod` 必须在符号边界稳定。** 它按点采样进 `ri_mod`，中途改会让同一符号的
I/Q 两轴用不同电平表。本件不含符号边界检测，上游负责。

**③ `i_conf` 的契约区是 `sh∈[3,34]` 加 `conf=0` 哨兵。** 超出该区时 `sh'` 落到
`≥48` 那一支、输出 0——是安全侧退化而不是乱数，但也意味着**上游给错 conf 不会被本件
报出来**。

**④ 输出无符号边界标记。** `m_axis_tlast` 只标一个**子载波**的最后一个比特，不标
OFDM 符号边界（上游 `eq_zf` 也不提供）。下游按 48 载波计数自行成帧。

**⑤ 验证边界**：judgement 走 Icarus Verilog 12.0；综合为 **OOC synth_design，非实现/
布线/时序收敛**。`synthesis-timing-evidence.json` 的 `fullEdaClosure: false` 如实记着
这一点。板级与整链回环未做。

## 6. 综合实测（Vivado 2023.1.1，OOC，xc7k325tffg900-2）

| 项 | 实测 | 包络 |
|---|---|---|
| WNS @10 ns | **+4.508 ns**（≈181 MHz） | ≥ 0 |
| WHS | +0.123 ns | ≥ 0 |
| 失败端点 | **0** | 0 |
| LUT | 2220 | 2400 |
| FF | 1044 | 1150 |
| BRAM | 0 | 0 |
| DSP | **18** | 20 |

**DSP 18 恰好 = 16 个 metric 平方器（两轴各 8）+ 末级 33×16 乘法的 2 个。** 这是数据
通路少复位换来的：给 `r2_sq` / `r1_prod` 加复位会挡住 DSP 内部寄存器吸收，把乘法赶到
LUT 上。`tb_demap_reset` 的 T3 反过来锁住这一点——少复位是**有意的**，谁日后顺手补上
就会失败。

## 7. 复现

```bash
# 仿真 (iverilog)，六次实跑: 3 个子模块 + 顶层三档
node engineering-assets/incubator/intake/mod_demapper/run_sim.cjs --install

# 第二仿真器 (xsim)
node engineering-assets/incubator/intake/mod_demapper/run_sim.cjs --install --xsim

# 判卷向量重生成 (期望值走治理侧镜像; 非治理侧路径直接报错)
matlab -batch "addpath('<pkg>/analysis'); gen_demap_vectors('16QAM')"

# 综合 + 门禁
node engineering-assets/tools/pg-synth.cjs engineering-assets/incubator/intake/mod_demapper
node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/intake/mod_demapper --repo-root .
```

## 8. 门禁现状

21/22 过。**还差一条：G-SIGN-01（owner 签字）**——这是认证前置，只能由 owner 给。

签字后按 D1 规则迁入 `cbb/mod_demapper/`，并封存
`evidence/mod_demapper/1.0.0/SNAPSHOT.json`。
