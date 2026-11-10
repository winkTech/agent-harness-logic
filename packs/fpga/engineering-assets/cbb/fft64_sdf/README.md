<!-- asset-status: certified v1.0.2 -->
<!-- 级别横幅（由成熟度派生）: CERTIFIED — 全门绿 + owner 签署 (2026-08-04) -->

# fft64_sdf

> `asset_uid: fft64_sdf` · `version: 1.0.2` · `owner: lihan`
> 成熟度: **certified** — 21 道门全绿 + owner 签署（lihan, 2026-08-04）。
> **认证覆盖的是 `P_DIR=0`（FFT）配置**；IFFT 方向无 bit-true 对拍，见 §6
> 协议锚点: IEEE 802.11-2020 Clause 17（11a/g OFDM 20MHz）· `baseline`

64 点流式 FFT/IFFT 核，**方向**与**输出序**均可参数化。基-2² 单路延迟反馈
（R2²SDF）结构，6 级反馈延迟 32/16/8/4/2/1，完整复乘仅 2 个。

服务 RX 链路：`sync_top → cp_remove → **fft64_sdf** → {channel_est_top, 均衡器}`。

---

## 1. 文件

| 文件 | 作用 |
|---|---|
| `rtl/fft64_sdf.sv` | 顶层：按 `P_NATURAL_OUT` 组合 core 与 reorder，**纯接线** |
| `rtl/fft64_sdf_core.sv` | R2²SDF 核，恒位反序输出 + 侧带透传 |
| `rtl/fft64_reorder.sv` | 位反序→自然序乒乓重排 |
| `rtl/fft64_twiddle.svh` | 旋转因子表（打包常量） |

## 2. 接口与数值契约

| 项 | 约定 |
|---|---|
| 输入 | `i_beat`(CE) / `i_valid` / `i_re,i_im` **Q2.14**，自然序，每符号连续 64 拍 |
| 输出 | FFT → **Q2.14**；IFFT → **Q3.13** |
| 侧带 | `i_sb` 标记输入符号首拍；`o_sb` 与本符号**首个输出**同拍 |
| 缩放 | 两方向同为 `Σ(...)/8`，级 2/4/6 蝶形后各 `(x+1)>>>1` |
| 内部位宽 | **s21**（见 §4 第 1 条，s20 会回绕） |
| 反压 | 无。上下游（cp_remove / core）均无 `ready`，不可停顿 |

**输出格式两方向不同不是缺陷**：输出级对 IFFT 多做的那次 `(x+1)>>>1` 是
Q2.14→Q3.13 的**格式转换**而非缩放，同一物理量的整数值因此差一倍。拿同一个整数
期望值套两个方向会误判。

**方向切换须翻两处符号，缺一不可**：非平凡旋转因子表的虚部，**以及** BF2II 的
平凡 ±j。只翻其一时输出会错到比信号本身还大（golden 侧实测最大误差 46725 LSB
而信号幅度仅 17800 LSB）。

## 3. 验证现状

| TB | 覆盖 | 结果 |
|---|---|---|
| `tb_fft64_sdf_core` | 冲激→频谱平坦 / 直流→仅 bin0 / Nyquist→仅 bin32 / 侧带 / 复位 | PASS |
| `tb_fft64_reorder` | 自然序还原 / 乒乓无串扰 / 侧带落位 | PASS |
| `tb_fft64_direction` | 复数单音：FFT→bin1，IFFT→bin63 | PASS |
| `tb_fft64_sdf` | 顶层两种输出序配置的接线与输出序 | PASS |
| **`tb_fft64_cosim`** | **对治理 golden 定点镜像 0 容差，2560 样点** | **0 失配** |
| `tb_fft64_reset` | 流水灌满后复位，41 个受复位寄存器逐项比对 | PASS |
| `tb_fft64_stability` | boundary（满幅饱和不回绕）/ stress（64 符号）/ backpressure（CE 冻结） | PASS |
| `tb_fft64_tail` | 撤 valid 恰好卡 1 个符号；补 64 拍全排空（冲刷契约数） | PASS |

前四个用**解析可知**的判据证明结构、方向、缩放、侧带与输出序没接错；它们
**证明不了逐位一致**。`tb_fft64_cosim` 才是 bit-true 判据。不要拿"TB 全绿"
当 bit-true。

方向专项单独立一个 TB 是有原因的：实数且对称的激励（冲激/直流/Nyquist）对两个
方向给出**相同**结果，那类判据分辨不出方向符号翻没翻对——必须用复数单音。

复现：见 §5。

## 4. 已知限制

完整清单见 [`docs/limitations.md`](docs/limitations.md)，重点三条：

1. **内部 s21 是必需的，不是保守**。满幅 Q2.14 输入下移位前逐轴上界 45.25，
   超出 s20 的 ±32；对抗构造实测最坏 40.71。真实 OFDM 信号峰值仅 3.6~4.7。
   1.0.x 的 boundary 子结果给出了直接观测：满幅直流下 bin0 饱和到 +32767 而非
   回绕成负数。
2. **输入必须已被 AGC 缩到不削顶**。理想 OFDM 时域峰值 2.64 > Q2.14 的 ±2。
3. **对拍向量的字序是 `{re, im}`**，与 `cp_remove` 的 `{im, re}` 相反。写反了不会
   报错，只会看起来像"变换方向算反了"——交换 re/im 等价于 `z → j·conj(z)`。

## 5. 复现

一条命令跑完全部 8 个 TB 并把证据落到 `var/gates/pg/fft64_sdf/`：

```bash
node engineering-assets/cbb/fft64_sdf/run_sim.cjs --install
node engineering-assets/tools/gate-runner.cjs cbb/fft64_sdf --repo-root .
```

去掉 `--install` 就只跑不写证据。任一 TB 不过即整体失败且不写任何证据。
单跑 bit-true 对拍：

```bash
# iverilog; 本机 ModelSim 回环 RPC 自 2026-08-01 起故障
iverilog -g2012 -I <PKG>/rtl -o <PKG>/sim/tb_cosim.vvp \
  <PKG>/rtl/fft64_sdf_core.sv <PKG>/rtl/fft64_reorder.sv \
  <PKG>/rtl/fft64_sdf.sv <PKG>/tb/tb_fft64_cosim.sv
vvp <PKG>/sim/tb_cosim.vvp
```

**第二仿真器交叉验证**（1.0.1 起）：加 `--xsim` 即用 Vivado xsim 2023.1 跑同一批
TB、同一套判据。8/8 全过，bit-true 那条由两个独立仿真器各自确认。

**链路级测量**（`tb/integration/`，必须用 xsim——iverilog 编译不了 `channel_est_top`）：

```bash
cd <BUILD> && EA=<engineering-assets>
xvlog --sv -i $EA/cbb/fft64_sdf/rtl \
  $EA/cbb/fft64_sdf/tb/integration/tb_chain_depth.sv \
  $EA/cbb/cp_remove/rtl/cp_remove.sv $EA/cbb/fft64_sdf/rtl/*.sv \
  $EA/cbb/channel_est_top/rtl/*.sv
xelab -debug typical -timescale 1ns/1ps tb_chain_depth -s chain_sim && xsim chain_sim -R
```

`tb_chain_depth` 测真实链路（反压 0 / 峰值 1 / 帧尾卡 64 样点），
`tb_chain_nogap` 测去掉 CP 间隙的对抗上界（反压 22 / 峰值 23）。

向量由 `models/comm/ofdm` **1.4.1 治理资产**的 `src/rtl_mirror_fft64.m` 产出
（40 个真实 OFDM 符号，AGC 缩到刚好不削 Q2.14）。G-B-03 的证据出自该路径，
重生成脚本对它做了硬断言，防 scratchpad 旧副本遮蔽。

## 6. 认证状态与复用边界

**CERTIFIED**（21 道门全绿 + owner 签署 lihan / 2026-08-04）。

| 门 | 结果 |
|---|---|
| G-B-03 位真 | 对治理 golden `rtl_mirror_fft64` **2560 点 0 失配** |
| G-C-01 时序 | WNS **+6.323 ns** @10ns（272.0 MHz），WHS +0.158 ns，0 失败端点 |
| G-C-02 资源 | LUT 2251/2800 · FF 5033/6000 · BRAM 0/2 · **DSP 10/12** |
| G-C-04 复位/CDC | 41 个受复位寄存器逐项比对 + 单时钟域结构扫描（`cdc_tool=na`） |
| G-C-05 稳定性 | boundary / stress / backpressure / regression 四子结果均 pass |
| G-GATE-01/02 | 证据齐备且可由 `run_sim.cjs` 重做 |

### 复用前必须知道的两条

1. **认证覆盖的是 `P_DIR=0`（FFT）。** IFFT 方向**没有 bit-true 对拍**——现有向量
   是正向的，反向只由方向专项 TB 与解析判据覆盖。要把本核回切给 `ofdm_tx_top`
   复用，须先补 IFFT 方向的 0 容差对拍。
2. **与 `channel_est_top` 之间需要 `cbb/sb_align`。** 不是为了弹性——实测下游零反压
   （§4 与 `docs/limitations.md` §4）——而是为了**侧带对齐**：本模块的 `o_sb` 与符号
   首个输出同拍，而 `channel_est_top` 要求 `frame_start` 领先 ≥1 拍。直连不报错但
   静默出错（实测 372/384 点值不同）。`sb_align` 同时也是"上游节奏若变化需深度 23"
   那条风险的承接点（调 `P_DEPTH` 即可）。

完整清单见 `manifest.signoff.scope`。未覆盖项：板级验证。
**第二仿真器交叉验证已在 1.0.1 还清**（xsim 8/8）。

<!-- BEGIN:MANIFEST:PORTS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Dir | Width | Bus |
|---|---|---:|---|
| `i_clk` | input | 1 | — |
| `i_rst` | input | 1 | — |
| `i_beat` | input | 1 | — |
| `i_valid` | input | 1 | — |
| `i_re` | input | 16 | — |
| `i_im` | input | 16 | — |
| `i_sb` | input | 1 | — |
| `o_valid` | output | 1 | — |
| `o_idx` | output | 6 | — |
| `o_re` | output | 16 | — |
| `o_im` | output | 16 | — |
| `o_sb` | output | 1 | — |
<!-- END:MANIFEST:PORTS -->

<!-- BEGIN:MANIFEST:PARAMS -->
<!-- Generated from manifest.json; do not edit this block. -->
| Name | Values | Support |
|---|---|---|
| `DATA_W` | — | yes |
| `P_W` | — | yes |
| `P_DIR` | — | yes |
| `P_NATURAL_OUT` | — | yes |
<!-- END:MANIFEST:PARAMS -->

<!-- BEGIN:MANIFEST:CLOCKRESET -->
<!-- Generated from manifest.json; do not edit this block. -->
| Field | Value |
|---|---|
| Clock | `i_clk` (10 ns) |
| Reset | `i_rst` / active_high / sync |
<!-- END:MANIFEST:CLOCKRESET -->
