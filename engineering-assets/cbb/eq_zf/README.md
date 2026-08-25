# eq_zf — ZF 频域均衡 + 数据子载波提取

`X_k = Y_k · conj(H_k) · (1/|H_k|²)`，只在 48 个数据子载波上算，输出直接就是下游
`mod_demapper` 期望的 48 个载波、且是它期望的**顺序**。

当前成熟度 **intake**（0.1.0）。RTL、判据 TB、位真向量齐备且双仿真器全绿，OOC 综合
证据已产出；未做签字与复位/稳定性子结果，故不声称更高级别。

## 1. 接口

| 端口 | 方向 | 位宽 | 说明 |
|---|---|---|---|
| `i_y_valid` / `i_y_re` / `i_y_im` / `i_y_idx` / `i_y_sb` | in | 1/16/16/6/1 | Y，直连 `fft64_sdf` 输出。Q2.14 自然序，`i_y_sb` 标记 LTS1 首拍（每帧一拍） |
| `s_axis_h_tvalid/tready/tdata` | in/out/in | 1/1/32 | H，直连 `channel_est_top` 的 `m_axis`。Q2.14 |
| `m_axis_tvalid/tready/tdata` | out/in/out | 1/1/32 | X，Q4.12 |
| `o_erasure` | out | 1 | 与 X 同拍：该载波因 `\|H\|²=0` 而无信息 |
| `o_y_overflow` | out | 1 | 粘滞。**集成方必须接出去看**，理由见 §4 |

打包字序统一 **`{im, re}`**，与 `cp_remove` / `channel_est_top` 一致。
（注意：`fft64_sdf` 的判卷 TB 用的是 `{re, im}`——本轮曾因此产生 2327/2560 的假失配。）

## 2. 结构

```
Y ──┬─────────────────────────► Y 路 FIFO (256) ──┐
    │                                              ├─► 共轭乘 ─┐
H ──┴─► |H|² ─► eq_recip (6 拍) ────────────────────┘          ├─► 定标+饱和 ─► 出侧 FIFO ─► eq_reorder ─► m_axis
                 归一化 → 256 项 ROM → Newton                   │
                                        └─ o_zero ─────────────┘  (置零 + erasure)
```

| 子模块 | 行数 | 职责 |
|---|---|---|
| `eq_zf` | 300 | Y 路 FIFO、符号/载波选择、共轭乘、定标饱和、erasure |
| `eq_recip` | 195 | 归一化 + 闭式 ROM + 一次 Newton，固定 6 拍 |
| `eq_reorder` | 146 | 自然 bin 升序 → golden 序（左旋 24），双 bank 乒乓 |

## 3. 正确性依据

规格的单一事实源是 **`models/comm/ofdm/src/rtl_mirror_eq.m`**（定点位真镜像）。它
**写在本 RTL 之前**，所以不存在被 RTL 带偏的可能；归一化移位范围、ROM 的地址与内容
公式、Newton 的三步整数写法、末级 `sh=33-s` 的加半右移与 int16 饱和，全部由它钉死。
**cosim 失配时修 RTL，不改镜像。**

判卷是 **0 容差**：镜像与 RTL 走同一条整数路径，差异只可能是缺陷，不存在"量化噪声"
这个解释。实测 **2304 点 0 失配**（≥ G-B-03 的 2048 门限），iverilog 与 Vivado xsim
2023.1 各自复跑。

三个 TB 都写在对应 RTL 之前：

- `tb_eq_zf` —— 位真主判据 + 反压 + 复位 + 包络外溢出可见性
- `tb_eq_recip` —— **ROM 闭式 == 镜像导出 hex（256 项）** + 标定 + TB 内独立 SV 参考逐位比对 1522 点 + 归一化两端边界
- `tb_eq_reorder` —— 闭式 `出[p] == 入[(p+24)%48]` + 多符号不串 + 反压 + 复位

## 4. 已知边界（集成方必须落实）

**下游平均接受率必须 ≥ 80%。** 上游 `fft64_sdf` 无 ready、结构上停不下来，而 Y 的
占空是 64/80 = 80%（符号间有 16 拍 CP 空窗）。下游若长期低于这个速率，Y 只能堆积——
**加深 FIFO 只是推迟不是解决，平均速率不够就是不够。**

此工况下本件**拉起 `o_y_overflow` 而非静默丢点**。实测：下游逐拍翻转（50%）时溢出
标志确实置起。不接这根线，丢点就是静默的。

**`P_YDEPTH` 必须是 2 的幂。** 指针按 `2^YAW` 回绕，非 2 的幂会越界读出 X。首版取
192（`$clog2(192)=8` → 实际回绕于 256）就是如此，症状是前 192 点全对、第 193 点起
吐 `xxxxxxxx`。

## 5. 子载波输出序

出的是 **golden 序**（`cfg.data_idx` 序，即 bin 38..63 再 1..26），不是自然 bin 升序。

依据不是偏好而是事实：`rx_chain.m` 第 3 步按 `cfg.data_idx(d)` 取 bin 再喂
`mod_demapper`，发端 `subcarrier_map` 用同一序放数据——**比特与子载波的对应关系由
该序定义，换序等于把比特打乱**。硬件顺着 FFT 输出流只能按 bin 升序出，两者恰差左旋
24，这一步由 `eq_reorder` 承担（与裁定③ 把 64→48 提取放在件内是同一理由）。

## 6. 综合实测（Vivado 2023.1，OOC，xc7k325tffg900-2）

| 指标 | 实测 | 包络 |
|---|---|---|
| WNS | **+3.861 ns** @ 10ns（≈163 MHz） | ≥ 0 |
| WHS | +0.100 ns | ≥ 0 |
| 失败端点 | **0**（setup 1782 / hold 1782 / PW 465） | 0 |
| LUT | 872（logic 713 + memory 159） | 900 |
| FF | 290 | 320 |
| BRAM | 1.5 | 2 |
| DSP | 12 | 14 |

ROM 内容按**闭式**在综合期生成而非 `$readmemh`：`pg-synth` 让 Vivado 跑在
`var/gates/pg/<uid>/` 而不是包目录，相对路径的 hex 找不到。`rtl/eq_recip_lut.hex`
仍作镜像的权威导出保留，由 `tb_eq_recip` 的 T0 断言两者逐项相同——**不是删掉一了百了**。

## 7. 复现

```bash
# 仿真 (iverilog)
cd engineering-assets/incubator/intake/eq_zf/rtl
iverilog -g2012 -o tb.out ../tb/tb_eq_zf.sv eq_zf.sv eq_recip.sv eq_reorder.sv && vvp tb.out

# 第二仿真器 (xsim)
xvlog --sv ../tb/tb_eq_zf.sv eq_zf.sv eq_recip.sv eq_reorder.sv
xelab -debug typical -timescale 1ns/1ps tb_eq_zf -s s && xsim s -R

# 判卷向量重生成 (期望值走治理侧镜像)
matlab -batch "addpath('<pkg>/analysis'); gen_eq_vectors"

# 综合 + 门禁
node engineering-assets/tools/pg-synth.cjs engineering-assets/incubator/intake/eq_zf
node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/intake/eq_zf --repo-root .
```

## 8. 门禁现状

机器判定 **QUALIFICATION**。已过的 certified 级门：

| 门 | 结果 |
|---|---|
| G-B-03 | 自检 TB PASS，**4370 次比对**（iverilog）／4391（xsim，`$urandom` 不同所致） |
| G-C-01 / G-C-02 | 时序与资源，见 §6 |
| G-C-04 | 复位逐寄存器比对（**27 项，0 失配**）+ 4 个少复位存储阵列未被清零 + CDC 报告 |
| G-C-05 | boundary / stress / backpressure / regression **四个子结果均 pass** |
| G-GATE-01 / G-GATE-02 | 证据齐备且复现入口存在 |

证据由 `run_sim.cjs` **解析实跑输出**产出，不是人工填：

```bash
node engineering-assets/incubator/intake/eq_zf/run_sim.cjs --install        # iverilog
node engineering-assets/incubator/intake/eq_zf/run_sim.cjs --install --xsim # 第二仿真器
```

`tb_eq_reset` 的复位判据有个容易做废的地方，值得记下来：注入复位**之前**必须先断言
状态是脏的（符号相位已推进、Y 路 FIFO 指针非零、流水在跑、重排 bank 在填）。对着一个
本来就空的设计复位永远会过，那种 PASS 没有信息量。

keep 判据只覆盖 4 个**存储阵列**（写使能全由已复位的 valid 链产生，复位期间恒为 0）。
无条件锁存的流水寄存器（`ri_ydat` / `rA_y` / `rB_h2` / `r_dly` / `r2_r0` / `ro_r1`）
**不在其中**——"少复位"是不加复位而非冻结，复位期间上游仍在驱动时它们本就会跟着变，
拿它们做 keep 判据只会测出激励在动。

### 还差一条

**G-SIGN-01 —— owner 签字。** 技术门已全过；签字是 owner 的判断，不由实现方代填。
