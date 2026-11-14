<!-- asset-status: certified v1.1.1 -->
<!-- 级别横幅（由成熟度派生）: CERTIFIED — 全门绿 + owner 签署 (2026-08-04) -->

# cp_remove

> `asset_uid: cp_remove` · `version: 1.1.1` · `owner: lihan`
> 成熟度: **certified** — 21 道门全绿 + owner 签署（lihan, 2026-08-04）。
> **可在生产设计中复用**，前提是遵守 §4 的接口契约与 `signoff.scope` 里的已接受限制
> 协议锚点: IEEE 802.11-2020 Clause 17（11a/g OFDM 20MHz）· `baseline`

按 802.11a 帧结构在 `sync_top` 的样点流上切窗，每符号输出连续 64 拍给 `fft64_sdf`。
纯选通与计数——**无算术、无存储**。

链路位置：`sync_top → **cp_remove** → fft64_sdf → {channel_est_top, 均衡器}`

---

## 1. 帧结构与切窗序列

参数取自 `models/comm/synch/config.m`（该 golden 引 IEEE 802.11a-1999 §17.3.3）：

| 段 | 长度 | 说明 |
|---|---|---|
| STS | 10×16 = 160 | 短前导，**本模块不见** |
| GI2 | 32 | 长前导保护间隔，**由 sync_top 在上游消化** |
| T1 / T2 | 各 64 | 长训练符号，**不带 CP** |
| 数据符号 | 16 + 64 = 80 | CP + 本体 |

`sync_top` 的 `o_fft_start` 与其 `m_axis` 上 **T1 首样点同拍**（ADR-003），故本模块
从 T1 起算。切窗序列：

```
i_fft_start → T1(取64) → T2(取64) → {跳16 取64} × i_cfg_n_sym → 冲刷(64拍零) → 回 UNSYNC
```

该序列正好喂出 `channel_est_top` 期待的 `[LTS1, LTS2, 数据符号...]`（见其模块头注释）。

## 2. 接口契约

| 项 | 约定 |
|---|---|
| 输入 | `s_axis_tvalid` / `s_axis_tdata[31:0]` = `{Q, I}` Q2.14 |
| | `i_fft_start` 单拍脉冲；`i_cfg_n_sym` 本帧数据符号数（帧内须稳定） |
| 输出 | `o_valid` / `o_re`(I) / `o_im`(Q) / `o_sb` |
| 侧带 | `o_sb` 只在 T1 首点打一拍，供 fft64_sdf 透传 |
| **输出长度** | `(2 + n_sym) × 64` **+ 64 拍帧尾冲刷**（1.1.0 起，见 §4 第 1 条） |
| 反压 | **无**。上游 `sync_top` 无反压契约、下游 `fft64_sdf` 无 ready，本模块不可停顿，也不提供 `tready` |

CP 期间输出无效（16 拍空档），由 fft64 的 `i_beat`/`i_valid` 消化。

**帧尾由 `i_cfg_n_sym` 静态给定**（owner 裁定 2026-08-03）：`sync_top` 是单突发语义、
无帧尾信号，而 SIGNAL 解码在范围外。若改为"自由流转到复位"，帧尾之后会把噪声当
符号吐给下游。

## 3. 验证现状

| TB | 覆盖 | 结果 |
|---|---|---|
| `tb_cp_remove` | 切窗序列 / 帧尾 / 侧带 / UNSYNC 静默 / 复位重入 | PASS |
| **`tb_cp_remove_cosim`** | **对治理 golden `rx_cp_window` 0 容差，2176 点** | **0 失配** |
| `tb_cp_remove_reset` | 帧中途复位后 8 个寄存器逐项比对 + 数据通路免复位断言 | PASS |
| `tb_cp_remove_stability` | boundary / stress / backpressure 三个子结果 | PASS |
| `tb_cp_remove_gap` | 帧间最小间隔逐值测量（测量 TB，非判据） | gap≥1 |

`tb_cp_remove` 用**编码下标**的合成流（样点值 = 其在输入流中的下标），任何错位都能
直接读出偏了多少；`tb_cp_remove_cosim` 用真实前导与数据符号走完整链路。

**位真证据出自治理资产**（`models/comm/ofdm` 的 `src/rx_cp_window.m`），非暂存副本。

## 4. 已知限制

见 [`docs/limitations.md`](docs/limitations.md)，重点四条：

1. **输出比切窗结果多 64 拍零**（1.1.0 起，§7）。数满后自驱吐 64 拍冲刷才回 UNSYNC——
   不补的话 `fft64_sdf` 流水里最后一个真符号永远出不来，每帧稳定丢一个数据符号。
   **集成方必须按 `(2+n_sym)×64 + 64` 收。**
2. **`i_cfg_n_sym` 必须 ≥ 1**：n_sym=0 时 RTL 仍吐 1 个数据符号，与 golden 不一致（§5）。
3. **帧间至少隔 1 个样点**：零间隔会整帧丢失下一帧（§6，逐值实测）。冲刷段响应
   `i_fft_start`，不会把这个下限抬高。
4. **`i_cfg_n_sym` 配错没有兜底**：配少截断有效数据，配多把噪声当符号吐给下游。
5. **不需要弹性缓冲**（§2）——1.0.0 曾写"M1 硬依赖"，1.0.1 实链测量推翻：真实链路
   反压 0 拍，CP 的 16 拍空档就是下游需要的全部弹性。

## 5. 复现

一条命令跑完全部 5 个 TB 并把证据落到 `var/gates/pg/cp_remove/`：

```bash
node engineering-assets/cbb/cp_remove/run_sim.cjs --install
node engineering-assets/tools/gate-runner.cjs cbb/cp_remove --repo-root .
```

去掉 `--install` 就只跑不写证据。任一 TB 不过即整体失败且不写任何证据。
单跑某个 TB：

```bash
iverilog -g2012 -o <PKG>/sim/tb_cosim.vvp \
  <PKG>/rtl/cp_remove.sv <PKG>/tb/tb_cp_remove_cosim.sv
vvp <PKG>/sim/tb_cosim.vvp
```

## 6. 认证状态

**CERTIFIED**（21 道门全绿 + owner 签署 lihan / 2026-08-04）。

| 门 | 结果 |
|---|---|
| G-B-03 位真 | 对治理 golden `rx_cp_window` **2176 点 0 失配** |
| G-C-01 时序 | WNS **+7.704 ns** @10ns（435.5 MHz），WHS +0.189 ns，0 失败端点 |
| G-C-02 资源 | LUT 30/60 · FF 86/120 · BRAM 0/1 · DSP 0/0 |
| G-C-04 复位/CDC | 8 个受复位寄存器逐项比对 + 单时钟域结构扫描（`cdc_tool=na`） |
| G-C-05 稳定性 | boundary / stress / backpressure / regression 四子结果均 pass |
| G-GATE-01/02 | 证据齐备且可由 `run_sim.cjs` 重做 |

**复用前请读 `manifest.signoff.scope`**——签字里逐条列了接受的限制，以及两条
未覆盖项：板级验证，和"仿真器只有 iverilog 一条路径、无第二仿真器交叉验证"。

<!-- BEGIN:MANIFEST:PORTS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Dir | Width | Bus |
|---|---|---:|---|
| `i_clk` | input | 1 | — |
| `i_rst` | input | 1 | — |
| `i_fft_start` | input | 1 | — |
| `i_cfg_n_sym` | input | 8 | — |
| `s_axis_tvalid` | input | 1 | axi-stream |
| `s_axis_tdata` | input | 32 | axi-stream |
| `o_valid` | output | 1 | — |
| `o_re` | output | 16 | — |
| `o_im` | output | 16 | — |
| `o_sb` | output | 1 | — |
<!-- END:MANIFEST:PORTS -->

<!-- BEGIN:MANIFEST:PARAMS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Values | Support |
|---|---|---|
| `DATA_W` | — | yes |
<!-- END:MANIFEST:PARAMS -->

<!-- BEGIN:MANIFEST:CLOCKRESET -->
<!-- Generated from manifest.json; do not edit this block. -->
| Field | Value |
|---|---|
| Clock | `i_clk` (10 ns) |
| Reset | `i_rst` / active_high / sync |
<!-- END:MANIFEST:CLOCKRESET -->
