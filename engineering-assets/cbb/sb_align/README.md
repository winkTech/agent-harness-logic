<!-- asset-status: certified v1.0.0 -->
<!-- 级别横幅（由成熟度派生）: CERTIFIED — 全门绿 + owner 签署 (2026-08-04) -->

# sb_align

> `asset_uid: sb_align` · `version: 1.0.0` · `owner: lihan`
> 成熟度: **certified** — 22 道门全绿 + owner 签署（lihan, 2026-08-04）。
> **复用前必读 `manifest.signoff.scope`**——尤其是 `o_overflow` 必须被接出去看
> 协议锚点: `neutral`（纯时序适配，不含任何协议语义）

`fft64_sdf` 与 `channel_est_top` 之间的**侧带对齐件**。纯时序适配，无算术、无协议语义。

链路位置：`sync_top → cp_remove → fft64_sdf → **sb_align** → channel_est_top`

---

## 1. 为什么需要它

两个已认证模块的时序契约**互相冲突**，而且冲突是明文的：

| 模块 | 明文契约 |
|---|---|
| `fft64_sdf` | `o_sb` 与本符号**首个输出同拍**（`fft64_reorder.sv:109`） |
| `channel_est_top` | `i_frame_start` 须**领先** ≥1 拍（模块头） |

直连**不会报错**，只是安静地给出错误的信道估计。同一激励下实测：

| | H 输出点数 | 逐点差异 |
|---|---|---|
| frame_start 领先 1 拍（参考） | 384 | — |
| frame_start 同拍（fft64 实际） | 384 | **372 / 384 不同** |

点数完全正常、值几乎全错——这是最难发现的一类失效。

根因在 `channel_est_top.sv:50-53`：`r_fs_pend` 由 `i_frame_start` 在本拍末置起，
而 `ri_fs_take` 用的是**当拍旧值**，同拍到达时 LTS1[0] 不被标记，标记落到下一个
样点，整个 LTS 窗错一位。

两边的时序各自都是明文且已签字的契约，冲突在它们**之间**——所以在它们之间解，
不动任何一边（需求门禁 2026-08-04 裁定）。

## 2. 做法：小深度 FIFO + 先报后送

带 `sb` 的样点轮到发送时，先出一个 `m_axis_tvalid=0` 且 `o_frame_start=1` 的
**气泡拍**，下一拍再送它。这样 frame_start 恰好领先 1 拍，**且那一拍没有别的样点
被接受**——否则标记会落到错的样点上。

气泡由 FIFO 吸收：fft64 的输出每符号本就有 16 拍 CP 空档，每帧一个气泡绰绰有余。

## 3. 接口契约

| 项 | 约定 |
|---|---|
| 输入 | `i_valid` / `i_re` / `i_im` / `i_sb`——**无 ready，上游不可停顿** |
| 输出 | `m_axis_tvalid` / `m_axis_tready` / `m_axis_tdata` = `{Q, I}` |
| | `o_frame_start`：领先其所标记样点 1 拍，该拍 `tvalid` 必为低 |
| | `o_overflow`：**粘滞**溢出标志 |
| 参数 | `DATA_W`（默认 16）、`P_DEPTH`（默认 4，须为 ≥2 的 2 的幂） |

**输出全部寄存**（红线 2）。RL-OUT 门禁只检测 "assign 输出 ← `always_comb` 信号"
这一条路径，本模块不用 `always_comb`，即便组合直出也能过——但那是钻检查器的空子，
这里按红线**本意**做了寄存。

## 4. 已知限制

见 [`docs/limitations.md`](docs/limitations.md)，重点两条：

1. **持续反压必然溢出**，任何有限深度都挡不住——上游不可停顿而下游可反压，这是
   结构性的。故 `o_overflow` 必须被集成方接出去看。
2. **`P_DEPTH` 只能吸收瞬态积压**。M1 工况实测 `channel_est_top` 零反压，深度 4
   绰绰有余；若上游节奏变化（CP 间隙消失），实测所需上界是 **23**——调参即可。

## 5. 验证现状

| TB | 覆盖 | 结果 |
|---|---|---|
| `tb_sb_align` | 侧带领先 1 拍 / 数据逐点透传 / 瞬态反压 / 溢出可见且粘滞 / 复位 | PASS |
| **`tb/integration/tb_ce_aligned`** | **接 `channel_est_top`：H 输出逐点等于"正确时机"参考** | **372→0 差异** |

第二个是本件存在意义的直接判据：同一套激励、同一个参考，只把 frame_start 的
时机换成"经 sb_align"，差异必须归零。

## 6. 复现

```bash
# 单模块 (iverilog)
iverilog -g2012 -o <PKG>/sim/tb.vvp <PKG>/tb/tb_sb_align.sv <PKG>/rtl/sb_align.sv
vvp <PKG>/sim/tb.vvp

# 链路级判据 (必须 xsim —— iverilog 编译不了 channel_est_top)
xvlog --sv <PKG>/tb/integration/tb_ce_aligned.sv <PKG>/rtl/sb_align.sv \
  <EA>/cbb/channel_est_top/rtl/*.sv
xelab -debug typical -timescale 1ns/1ps tb_ce_aligned -s s && xsim s -R
```

## 7. 认证状态

**CERTIFIED**（22 道门全绿 + owner 签署 lihan / 2026-08-04）。

| 门 | 结果 |
|---|---|
| G-B-03 | 结构原语判据 = 自检 TB 实跑 PASS，5 个场景 |
| G-C-01 时序 | WNS **+8.100 ns** @10ns（≈526 MHz），WHS +0.090 ns，0 失败端点 |
| G-C-02 资源 | LUT 37/80 · FF 42/90 · BRAM 0/1 · DSP 0/0 |
| G-C-04 复位/CDC | 7 个受复位寄存器逐项比对 + 存储阵列免复位断言 + 单时钟域扫描 |
| G-C-05 稳定性 | boundary（含吸收能力**实测** 5 拍）/ stress（64 符号）/ backpressure（分档）/ regression |
| G-GATE-01/02 | 证据齐备且可由 `run_sim.cjs` 重做 |

**第二仿真器交叉验证已还清**：3 个判据 TB 在 Vivado xsim 2023.1 上同一份 TB、
同一套判据复跑全过（3/3）。这是前两包 1.0.0 时的短板，本件从一开始就还清。

**复用前必读 `manifest.signoff.scope`**——最要紧的一条：`o_overflow` 必须被接出去看。
不看它，丢样点就是静默的。
