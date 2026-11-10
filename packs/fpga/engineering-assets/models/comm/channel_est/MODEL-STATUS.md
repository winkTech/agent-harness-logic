# models/comm/channel_est —— 参考模型状态记录

> 记录日期: 2026-07-26。结论来自 MATLAB R2022a 实跑, 非推测。
> **当前状态 (2026-07-31 更新): L1 已裁决并实施完成, `run_all_tests` 7/7 PASS。**
> 裁决与实施记录见 §6; 以下 §1-§5 为裁决前的原始记录, 保留作历史依据。
> (旧状态: 卡在 L1, 1/5 PASS, 阻塞原因是规格与测试矛盾而非代码缺陷)

## 1. 实跑结果

```
[1/5] LS+线性插值 — MSE 验证      FAIL  MSE -1.4 dB (要求 < -10)
[2/5] LS+DFT 插值 — MSE 验证      FAIL  DFT=-0.86 未优于 Lin=-1.37
[3/5] AWGN 信道 — 理想估计        PASS  MSE=-34.6 dB
[4/5] SNR 变化 — MSE 曲线         FAIL  不单调
[5/5] 调制阶数                    FAIL  QPSK MSE=-1.5 dB
```

唯一通过的是**理想 AWGN**(无多径), 说明 LS 估计与插值代码本身能算;
一旦引入多径就全线崩。

## 2. 定位: 不是代码坏, 是前提不成立

测试信道 `delay_profiles = [0, 0.2, 0.5, 0.8] µs`, `fs = 20 MHz`:

```
时延扩展 16 抽头  ->  相干带宽约 64/16 = 4.0 个子载波
导频 {-21,-7,7,21} -> 间隔 14 个子载波
```

导频间隔 14 远大于相干带宽 4 —— **违反信道在频域的采样定理**。
任何插值方法都无法从 4 个欠采样点重建一个 16 抽头信道;
`interp_dft` 里 `L = min(8, N_pilot) = 4`, 结构上也只能表示 4 抽头。

实测对照(同一信道、同一 seed、同为 data+pilot 子载波上的 MSE):

| 方案 | MSE |
|---|---|
| 4 导频 + 线性插值 (现方案) | **-1.88 dB** |
| 全用载波 LS (802.11a 用长训练符号的做法) | **-18.28 dB** |

即: 测试要求的 < -10 dB 是可达的, 但只有换估计基础才达得到。

> 附带排除的一条假设: 曾怀疑 MSE 被 `ls_channel_est` 强制置 1 的
> DC/保护子载波拉高。实测 全带 -1.37 dB vs 仅 data+pilot -1.88 dB,
> 保护带贡献 +0.33 dB —— **不是主因**, 该假设已否定, 未据此改代码。

## 3. 矛盾在哪

| 来源 | 说法 |
|---|---|
| `algorithm_spec.md:86` | 导频子载波 N_pilot = 4, 索引 {-21,-7,7,21} |
| `algorithm_spec.md:97` | LS + 线性插值 = **默认方案, 工程首选**, 要求 MSE < 10 |
| `algorithm_spec.md:57` | 线性插值适用条件写明: **"导频密集, 慢变信道"** |
| `tests/test_ls_linear.m` | 用 0.8 µs 时延扩展的 Rayleigh 信道, 要求 MSE < -10 dB |

规格自己列出的适用条件与测试选用的信道**直接冲突**。

## 4. 三条出路(需 owner 选, 未擅自选边)

1. **改估计基础**: 初始信道估计改用长训练符号(全部 52 个用载波)做 LS,
   4 个导频只用于后续残余相位跟踪 —— 这是 802.11a 的真实做法, 实测可达
   -18.28 dB。代价: `channel_est_top` 的架构、接口与资源预算都要跟着改。
2. **改信道模型**: 把 `delay_profiles` 收到 ≤4 抽头, 使导频间隔满足采样定理。
   代价: 验收信道变弱, 与 `algorithm_spec` 的"多径信道"场景描述不符。
3. **改判据**: 把 MSE 门限放宽到 4 导频能达到的水平。
   **不推荐** —— 那是把判据迁就结果, 违反 `docs/rules/03-gates.md`。

## 5. 影响范围

- `incubator/intake/channel_est_top` 的 G-B-03 在本条裁决前无法成立。
- 该包自身另有 32 条缺陷 (含: 64 拍单符号激励下**根本不产生输出**;
  唯一读参考向量的 TB 会把零输出报成 PASS; `pilot_cnt` 跨符号不复位导致
  第二符号写越界; 斜率流水相位错配与无符号部分选择丢符号位)。
  这些与本条独立, 但修它们之前应先定下估计基础, 否则架构可能推倒重来。
- 另: `ls_channel_est.m:36` 硬编码保护带 `[1:5, N-4:N]`(10 个),
  与 `config.m:19` 的 `[1:6, 60:64]`(11 个) 及 `algorithm_spec.md:88`(11 个)
  三方不一致 —— 这条是明确缺陷, 但影响量级仅 +0.33 dB, 待估计基础定下后一并改。

## 6. 裁决与实施记录 (owner: lihan 裁决 2026-07-31, 同日实施)

**裁决: 采纳方案 1 长训练符号 LS**(ADR-002, 见
`docs/governance/adr/ADR-002-channel-est-estimation-basis.md`)。

**实施**(MATLAB R2022a 实跑 `run_all_tests` **7/7 PASS**):

- 新增: `lts_seq.m`(802.11a LTS 频域序列) / `lts_channel_est.m`(2×LTS 平均
  全用载波 LS) / `pilot_phase_track.m`(4 导频 CPE 跟踪) / `sim_frame.m`
  (帧级激励: 2×LTS + nsym 数据符号, 可注入残余 CFO);
- 测试改造为 7 项: 默认方案在**原验收信道**(0.8µs)实测 **MSE -20.5 dB**
  (门限 -10); CPE 跟踪 max 误差 0.044 rad, EVM 27.5%→15.2%; AWGN -33.5 dB
  (理论 ≈-33); SNR 曲线严格单调; 三调制一致; 插值两测试移入其有效域
  (线性: 0.1µs 短时延; DFT: 均匀导频网格);
- 附带修复三处既有缺陷: ① 保护带三方不一致(§5 尾注, [1:5]→[1:6]);
  ② `interp_dft` 错误的 /sqrt(N/N_pilot) 归一化(全部估计值偏小 4 倍,
  被旧相对判据掩盖); ③ `interp_dft` 缺均匀网格**偏移补偿**(首导频不在
  k=1 时时域抽头相位旋转, 实测 -5.7→-13.9 dB);
- ~~遗留: §5 的 RTL 侧 32 条缺陷待架构重排(接口需接收 LTS 窗口);
  cosim 向量需按新基础重新导出(generate_vectors.m 改造随 RTL 阶段做)。~~
  → 已完成, 见下条。

**RTL 侧实施 (2026-07-31/08-01, channel_est_top 0.2.0 架构重排 + cosim 闭环)**:

- `channel_est_top` 按本裁决整体重排: 旧 4 导频 LS+插值通路删除,
  新 lts_estimator(2×LTS 全用载波 LS) + cpe_tracker(导频 CPE 跟踪) +
  cordic_cv(14 迭代); 接口新增 i_frame_start 侧带 (帧 = 2×LTS + n 数据符号)。
  §5 的 RTL 遗留缺陷随旧通路替换整体消灭。
- `generate_vectors.m` 改造为**帧级 RTL 位真镜像** (LTS 平均舍入/导频积/
  CORDIC 求角与旋转/round+饱和, 整数语义与 RTL 头注释逐字同步);
  规范调用 `generate_vectors(struct('nsym',32))`; CPE 镜像 vs 浮点
  最大偏差 1.8e-4 rad (= CORDIC Q3.13 量化尺度, 镜像自证)。
- cosim 实证 (ModelSim 10.6c): **2048 样点 0 失配 bit-true PASS**
  (G-B-03 证据 alignment-report.json); 定向 TB 六场景 ALL TESTS PASSED;
  Vivado OOC WNS +4.673ns@10ns, DSP 8 (<20 预算)。
- 勘误: 旧 rx_chEst.bin/expected_chEst.bin 单符号向量**从未入库**
  (0.1.0 README 已记录), 语义作废无需删除; manifest 1.2.0 provenance
  中"已删"一词不准确, 以本条为准。

## 7. 导频值订正 (2026-08-09, 1.3.0, owner 裁定)

本包的导频值一直是 **[1;1;-1;1]**（负号在子载波 **+7**），而 `models/comm/ofdm` 的
`cfg.pilot_val` 与 `cbb/ofdm_tx_top` 的 `tx_pilot_map` 都用 **[1;1;1;-1]**（负号在
**+21**，802.11a 的 P 序列）。**两侧约定相反。**

### 后果不是"略差"

CPE 估计量 `S = Σ Y[p]·conj(H[p])·pilot_assumed[p]`，每项带因子
`pilot_true·pilot_assumed`。两侧串起来时该因子为 `(+,+,−,−)`：

```
S = pol·e^{jθ}·( |H₋₂₁|² + |H₋₇|² − |H₊₇|² − |H₊₂₁|² )
```

**平坦信道下恰好抵消为 0**，`angle(0)` 无定义；频选信道下是个符号乱跳的残差。

### 为什么本包一直是绿的

`tests/test_phase_track.m` 自己也硬编码了同一个错值，与 `sim_frame.m` 互相印证。
订正 `sim_frame` 之后它**立刻**报 CPE 误差 3.141 rad —— 它本可以更早抓到这件事，
没抓到只是因为两边用了同一个错值。

更要紧的一条：`src/generate_vectors.m` 的注释原文是
`% cpe_tracker: 仅 k=39 取负` —— **golden 是跟着 RTL 写的**，正是治理要防的本末倒置。
它没被 file-protection 拦住，因为那次写入经 Bash 跑 MATLAB，不在该门的路径上。
而 `sim_frame.m` / `sim_channel.m` 把同一个错值标成"802.11a 导频序列"。
**同一个错值，一处冒称标准，一处自述跟随 RTL，两种说法都不对。**

### 改动与实测

| 文件 | 改动 |
|---|---|
| `sim_channel.m` / `sim_frame.m` | `[1;1;-1;1]` → `[1;1;1;-1]` |
| `pilot_phase_track.m` | 文档串订正 |
| `src/generate_vectors.m` | `pil_val` 订正，向量以 nsym=32 重生成 |
| `tests/test_phase_track.m` | `pilot_val` 订正 |

- `run_all_tests` **7/7**（订正前 [2/7] 恰好 π）
- `cbb/channel_est_top` 1.0.3 xsim 帧级 cosim **2048 点 0 失配 bit-true**，22 门 CERTIFIED
- `integration/contracts/chain_pilot_contract.m`：订正后**奇数符号误差 0.0000**

### 逐符号极性（独立缺陷）—— 已于 §8 解决

订正导频值**不能**解决它：判据内置的隔离诊断当时实跑证实，把导频值对齐后符号 2/4/6
仍差正好 π。处置见下节。

## 8. 逐符号导频极性 (2026-08-11, 1.4.0, owner 裁定方案 A)

本包此前**完全不建模导频极性**，而 TX 侧（`models/comm/ofdm` 的 `subcarrier_map`）
逐符号把四个导频整体 ±1 翻转。两侧串起来时每隔一个符号 CPE 差 π。

owner 2026-08-11 裁定**方案 A**：RX 跟随 TX 的 ±1 交替，不在本次顺带改标准合规性
（方案 B 是两侧一并改成 Clause 17 的 127 长 PRBS，要动 `ofdm_tx_top` 与
`channel_est_top` 两个已认证件，属另立一项）。

### 改动

| 文件 | 改动 |
|---|---|
| `sim_frame.m` | 数据符号循环施加 `pol = 1-2*mod(m-1,2)`，首符号 +1 |
| `src/generate_vectors.m` | 位真镜像的 S 累加与浮点自证各乘 `pol`（自证漏了 pol 会与镜像差 π，把"精度自证"变成噪声源） |
| `pilot_phase_track.m` | 文档：`pilot_val` 是**该符号实际发送值、含极性**，不是常量 P 序列 |
| `tests/test_phase_track.m` | 改为直接取 `fr.X_syms(pilot_idx,m)` |

### 测试为什么改成取真值

这条测试在本轮**踩了两次**：原先硬编码 `[1;1;-1;1]`，与 `sim_frame` 用同一个错值，
于是它本可以更早抓到约定不一致却没抓到（§7）；随后加极性时，硬编码常量又会第二次失配。
**测试里复写一份"应该是什么"，等于把被测对象抄了一遍，测的就成了抄得对不对。**

### 实测

- `run_all_tests` **7/7**
- `cbb/channel_est_top` 1.0.4：定向 TB **ALL TESTS PASSED**（T7 背靠背 8 符号跨 4 次
  极性翻转）；帧级 cosim **2048 点 0 失配 bit-true**
- `integration/contracts/chain_pilot_contract.m`：6 个符号 CPE 恢复误差**全部 0.0000 rad**；
  其反证段人为去掉 RX 极性后立刻差 **3.1416 rad** —— 证明该机制承重、判据不是空转

### 仍与标准不符（已知，非本次范围）

Clause 17 的极性来自 127 长 PRBS（x⁷+x⁴+1，全 1 初始），本链路两侧都用 ±1 交替。
方案 A 只保证**库内 TX↔RX 自洽**，不解决互通性；`cbb/ofdm_tx_top` 已登记为偏差 L3。
