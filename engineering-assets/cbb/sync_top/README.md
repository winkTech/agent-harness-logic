<!-- asset-status: certified v1.0.1 -->
<!-- 级别横幅（由成熟度派生）: CERTIFIED — 全门绿 + owner 签署 (2026-08-01) -->

# sync_top — 802.11a OFDM 突发同步顶层

> `asset_uid: sync_top` · `version: 1.0.0` · `owner: lihan`
> 成熟度: **certified** — 签署与证据快照见 manifest.signoff 与
> `../../evidence/sync_top/1.0.0/`；机器判据见
> `../../var/gates/pg/sync_top/gate-results.json`（路径基准 `cbb/sync_top/`）

## 用途（0.2.0, ADR-003 因果化架构）

802.11a 突发同步全链：短前导码递推自相关**包检测** → 平顶期相关累加
CORDIC 求角**粗 CFO 估计** → 因果 **NCO 旋转校正**（K 预缩放 + 14 级流水
CORDIC）→ 长前导码 T1 **符号量化互相关精定时**（0 DSP 加法树 + T2 防错锁）
→ 384 深延迟线对齐输出。0.1.0 的 25 条缺陷（检测虚警 99%、fft_start 恒 0
永不锁定、CFO 通路缺失等）随旧数据通路整体替换而消灭。

层级：`sync_top`（帧 FSM + NCO + 旋转）→ `sync_detect` + `cordic_cv`
（复用自 cbb/channel_est_top 1.0.0）+ `cordic_rot_pipe` + `sync_track_out`
（内含 `sync_correlator`）。

## 接口与契约（manifest 派生视图 + ADR-003）

| 端口 | 方向 | 位宽 | 说明 |
|---|---|---|---|
| i_clk / i_rst | in | 1/1 | 100 MHz；**同步复位，高有效** |
| s_axis_t{valid,ready,data} | AXI-S slave | 1/1/32 | ADC/信道样点 Q2.14 {Q,I}；tready 恒高 |
| m_axis_t{valid,ready,data} | AXI-S master | 1/1/32 | **因果 CFO 校正流**，相对 s_axis 固定延迟 **384 拍**；tready 被忽略（无反压契约） |
| o_fft_start | out | 1 | 与 m_axis 上 **T1 首样点同拍**的单拍脉冲 |
| o_sync_locked | out | 1 | 精定时完成置位，保持到复位（单突发） |

关键契约（详见 `docs/limitations.md` 与 ADR-003）：校正自
`corr_start = plat_end_idx + 40` 起（相位参考零于该点，之前样点 θ=0 过同一
流水 ≈恒等 ±8 LSB）；累积常数相位留给下游信道估计吸收；T2 防错锁判据
`|R(pk-64)|² ≥ |R(pk)|²/4`。

## 反偏离锚链

- 需求/算法: `knowledge/primary/domains/comm/synch/algorithm_spec.md`
- 架构裁决: `docs/governance/adr/ADR-003-sync-top-causal-contract.md`
- Golden: `model_comm_synch`（`run_all_tests` 5/5，L1/L2 绿）；T1 符号量化
  系数表由 golden 导出，cosim 逐位核对
- 定点/实现/资源三份历史报告仍锚定旧架构，待 qualification 阶段修订

## 验证现状（2026-08-01, 全部实跑取证）

- **定向自检 TB**（ModelSim 10.6c）：T1 (ε=+0.3/SNR 20dB/背靠背)、
  T2 (复位重入/ε=-0.2)、T3 (50% 间隙流拍域不变性) —— **ALL TESTS PASSED**：
  粗 CFO 误差 **0.0021/0.0025**（限 0.02）；`n_fine = 242` = TB 内浮点全精度
  互相关参考 = 注入真值（**0 样点误差**）；`o_fft_start` 与 m_axis T1 首样点
  同拍；直通段 81 样点 ±8 LSB；校正后 T1 相位集中度 **0.996**。
- **Vivado 2023.1.1 OOC**（xc7k325t, pg-synth 产物链）：**WNS +4.962 ns
  @10 ns**（≈198 MHz）；**LUT 6763 / FF 4669 / BRAM 1.5 / DSP 16**
  （预算 8000/5500/3/20）；证据见 `var/gates/pg/sync_top/`。
- **cosim（G-B-03, 0.2.1）**：golden `model_comm_synch` 1.1.0 位真镜像向量
  （2610 样点激励 / 2226 期望），**2226 样点 0 失配 bit-true PASS** +
  `fft_start` 对齐镜像 `n_fine=242=真值` + T1 符号量化表逐位核对；
  `fidelity = bit_true`。镜像+cosim 联合修复三缺陷见 CHANGELOG [0.2.1]。
- **证据链（G-C-04/05）**：`reset-sim.json`（27 个复位控制寄存器帧中
  再复位逐一比对）+ `stability/{boundary,stress,regression,backpressure}`。
- `tb/uvm/` 断链维持原状（不在验证面内）。

## 已知限制 / 认证阻塞

见 `docs/limitations.md`（10 条，含无反压契约、常数相位偏置、直通段
±8 LSB、T1 前段部分未校正与防错锁包络、单突发语义）。certified 阻塞：
G-B-03 位真向量、G-C-04/05 证据 dump、G-SIGN-01 签字。
