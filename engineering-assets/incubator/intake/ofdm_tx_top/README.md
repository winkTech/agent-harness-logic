# ofdm_tx_top — OFDM 发射机 (intake 评估性打包)

802.11a 风格 OFDM 发射链: 比特流 → 调制映射 → 导频/子载波映射 → 64 点 IFFT → CP 插入 → AXI-Stream 输出。
定点: 16bit, Q2.14 (频域) / Q3.13 (时域)。

> RTL 原自 `engineering-assets/knowledge/primary/domains/comm/ofdm/rtl/` 复制。
> **2026-07-28 已按 `docs/rules/01-hdl.md` 五条红线整改**，本 README 同步更新为整改后现状。
> 整改只动编码规范层面（命名/复位/输入输出寄存/三段式 FSM/位宽）；
> 算法与架构层面的遗留缺陷**未改**，逐条列在"遗留缺陷"一节。

## 结构

| 路径 | 说明 |
|:-----|:-----|
| `rtl/ofdm_tx_top.sv` | 顶层: 例化 mod_mapper → pilot_insert → xfft_64 → cp_insert |
| `rtl/mod_mapper.sv` | 适配层: 桥接顶层例化接口 → mapper (含 `!rst_n` 极性翻转) |
| `rtl/mapper.sv` | 调制映射 (BPSK/QPSK/16QAM; **64QAM 桩, 恒输出 0**), 3 级流水 |
| `rtl/pilot_insert.sv` | 导频插入 + 子载波映射 (802.11a 分配) |
| `rtl/cp_insert.sv` | CP 插入, 双 RAM 乒乓 |
| `tb/xfft_64.sv` | Xilinx FFT IP **行为级占位模型** (队列延迟线透传, **不可综合**, 不做真实 IFFT)。整改时由 `rtl/` 移入 `tb/`：它是验证支撑件而非设计源码，放在 `rtl/` 会让"本包 RTL 集合可综合"这一前提不成立。其端口名沿用 Xilinx IP 契约（`aclk`/`aresetn`/`event_*`），按"标准总线保持协议原名"豁免；极性转换在顶层 `.aresetn(~i_rst)` 完成。 |
| `tb/tb_tx_top.sv` | 黄金向量比对 TB (`tb_ofdm_tx_top`), 读 freq_i/q.bin 驱动, 比对 expected_tx.bin ±1LSB |

Golden model: `engineering-assets/models/comm/ofdm/` (asset_uid: `model_comm_ofdm`)。
UVM 环境: 源库另有 `engineering-assets/knowledge/primary/domains/comm/ofdm/uvm_tb/README.md`, 指向 `docs/templates/uvm/` 的共享模板 (ofdm_uvm_pkg.sv / axi_stream_if.sv / tb_ofdm_uvm_top.sv), 未随包复制。
原仿真脚本 `engineering-assets/knowledge/primary/domains/comm/ofdm/rtl/run_sim.do` 引用源库相对路径, 未随包复制 (避免携带失效路径)。

## 红线整改结果

| 红线 | 整改前 | 整改后 |
|:-----|:-------|:-------|
| 1 输入寄存 `ri_` | 各模块输入直通使用 | `pilot_insert` / `cp_insert` 新增 `ri_` 输入寄存级；`mapper` 的 Stage1 即输入寄存级 |
| 2 输出寄存 `ro_` | `cp_insert` 输出由组合 RAM 读直出、`m_axis_tvalid = output_valid && m_axis_tready`（兼违 AXI-S）；`mapper` 输出取自 `r_` 级间寄存器 | 全部由 `ro_` 驱动；`cp_insert` 改同步 RAM 读；`tvalid` 与 `tready` 解耦 |
| 3 同步复位 `i_rst` | 全链 `negedge rst_n` 异步低有效，`mod_mapper` 靠 `!rst_n` 翻转 | 全部同步高有效 `i_rst`，翻转层取消 |
| 4 三段式 FSM | `pilot_insert` / `cp_insert` 为二段式 | 均改三段式（次态组合 / 状态寄存 / 输出寄存），`default` 齐备 |
| 5 无锁存器 | 未发现违规 | 保持 |
| §5 位宽 | `m_axis_tdata` 声明 16 位却赋 32 位 `{I,Q}`，I 路被静默截断 | 改为 `[DATA_WIDTH*2-1:0]`，与文档声明的打包语义一致 |
| §6 阻塞/非阻塞 | `mapper.sv:94` 时序块内阻塞赋值，与同块 `<=` 混用 | 全部改非阻塞 |
| 命名 | `clk`/`rst_n`/`cfg_*` 无前缀 | `i_clk`/`i_rst`/`i_cfg_*`；内部 `ri_/ro_/r_/w_`；状态 `P_` |

**接口与延迟契约变化**（使用方必须知道）：

- `ofdm_tx_top.m_axis_tdata` 由 16 位变 **32 位**（原声明是错的，I 路一直被丢弃）
- `cfg_*` 三个端口更名为 `i_cfg_*`（注意：它们**在模块内从未被使用**，见遗留缺陷 F1）
- `mapper` 输出相对输入由 2 拍变 **3 拍**；`pilot_insert` / `cp_insert` 各 **+1~2 拍**
- `mapper` 三级流水改为统一使能，反压时整条冻结（此前反压会覆盖未收走的数据）

## 遗留缺陷（本次**未改**，需算法/架构决策）

| 编号 | 位置 | 问题 |
|:-----|:-----|:-----|
| F1 | `ofdm_tx_top.sv` | `i_cfg_fft_len` / `i_cfg_cp_len` / `i_cfg_mod_type` **在模块内完全未使用** —— 运行时配置未实现，实际由 parameter 静态决定。 |
| F2 | `cp_insert.sv` | `r_wr_bank` **没有翻转逻辑**，乒乓机制未实现。整改前它连复位值都没有（仿真恒 X），现已确定性复位为 0，但写永远进 bank A、读永远读从未被写过的 bank B。 |
| F3 | `cp_insert.sv` | `r_sym_cnt` 只有 6 位（0..63），但 `P_READ_SYM` 要数到 `FFT_LEN+CP_LEN-1 = 79`，回绕后条件永不成立，读状态出不去。 |
| F4 | `cp_insert.sv` | FSM 死状态 `P_WRITE_SYM` / `P_DONE` 不可达；`s_axis_tready` 表达式引用 `P_WRITE_SYM`，该项恒假。 |
| F5 | `pilot_insert.sv` | FSM 死状态 `P_FILL_GUARD_DC` / `P_FLUSH` 不可达；`r_bin_cnt` 递增不受握手门控，上游无数据时子载波索引照走，符号边界会漂。 |
| F6 | `pilot_insert.sv` | 导频极性只由 `first_sym` 区分，与 802.11a 的 127 长 PRBS 导频扰码序列不符。 |
| F7 | `mapper.sv` | 64QAM 是桩：`qam64_map` 恒输出 0。 |
| D1 | `mapper.sv` | `s_axis_tready` 仍是组合输出（AXI-S ready 反压路径天生组合）。要打断它需在边界外套一级 `incubator/intake/axis_skid_buffer`，属接口架构改动。整改前同样是组合的，非回归。 |
| F8 | `tb/xfft_64.sv` | 透传占位，不做 IFFT 运算 → 顶层输出与 golden `expected_tx.bin` 不可能对齐，fidelity 只能为 `pending`。 |

**F2+F3+F4 叠加的后果**：`cp_insert` 当前不能产出正确的 CP 符号流。修复须整体重做乒乓与符号计数架构。

## TB 现状

- `tb/tb_tx_top.sv` 随整改同步更新（端口名 + 复位极性 + `i_cfg_*`），并补了失败时的 `$fatal`
  —— 此前失败 run 的退出码与通过相同，上游读不出区别。
- 此前记录的"假绿"（`expected_len` 未赋值 → 比对 0 样点报 PASS）**已在更早的提交中修复**，
  当前 TB 会在驱动/捕获为 0 时 `$fatal`，并把 X/Z 显式计为失配。
- **仍未解决**：`drive_stimulus` 把 `freq_i/freq_q` 读进 `vec_i/vec_q` 后并未使用，
  实际驱动的是硬编码常量 `6'b0001_01`。DUT 入口是比特流而 `freq_*.bin` 是 golden 的
  频域中间量，二者不同层 —— **本 TB 与 `expected_tx.bin` 的比对在语义上不成立**，
  需 golden 导出比特激励后重做。
- **TB 向量路径/规模失配**：`VEC_DIR` 需由 `run.do` 注入到 `models/comm/ofdm/vectors/`；
  TB 期望 N_SYM(10)×64 样点，向量文件仅 1 符号（freq 64 行 / expected 80 行）。
- 整改验证证据：`mapper` 模块级性质 TB（scratchpad，未入库）—— 900 拍随机反压下
  不丢不重、符号值逐笔正确、输出无 X、`tvalid` 未撤回。全包 `vlog -sv` 编译干净。
- **未验证项**：资源 / Fmax / 时序 / 可综合性均未跑 Vivado，无报告支撑。

## 向量健康度抽查 (2026-07-25)

expected_tx.bin: 80 行 64 唯一值; tx_i/tx_q: 80 行 63-64 唯一值; time-domain-iq.txt: 80 行 64 唯一值 — 无常量轨/全同值损坏 (rrc 曾出现的整文件坏轨未在本模块复现)。freq_i/freq_q 唯一值 5/3, 为 QPSK 星座 (±0x5A82/0xA57E/0) 的正常离散取值。
已知不一致: generate_vectors.m 注释称频域 Q2.14 但按 32767 (Q1.15) 缩放导出 — 已在 model manifest 中记录, 未修改 golden。

## 门禁

```bash
node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/intake/ofdm_tx_top
```

结果见 gate-runner 输出与 `engineering-assets/var/` 下留档。
