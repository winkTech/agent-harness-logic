# ofdm_tx_top — OFDM 发射机 (intake 评估性打包)

802.11a 风格 OFDM 发射链: 比特流 → 调制映射 → 导频/子载波映射 → 64 点 IFFT → CP 插入 → AXI-Stream 输出。
定点: 16bit, Q2.14 (频域) / Q3.13 (时域)。

> 本包为**评估性打包** (intake): RTL 自 `knowledge/primary/domains/comm/ofdm/rtl/` 原样复制, **未做任何修改**。
> 所有红线违规如实记录于下文, 不在打包阶段修复。

## 结构

| 路径 | 说明 |
|:-----|:-----|
| `rtl/ofdm_tx_top.sv` | 顶层: 例化 mod_mapper → pilot_insert → xfft_64 → cp_insert |
| `rtl/mod_mapper.sv` | 适配层: 桥接顶层例化接口 → mapper (含 `!rst_n` 极性翻转) |
| `rtl/mapper.sv` | 调制映射 (BPSK/QPSK/16QAM; **64QAM 桩, 恒输出 0**), 3 级流水 |
| `rtl/pilot_insert.sv` | 导频插入 + 子载波映射 (802.11a 分配) |
| `rtl/xfft_64.sv` | Xilinx FFT IP **行为级占位模型** (队列延迟线透传, 不可综合, 不做真实 IFFT) |
| `rtl/cp_insert.sv` | CP 插入, 双 RAM 乒乓 |
| `tb/tb_tx_top.sv` | 黄金向量比对 TB (`tb_ofdm_tx_top`), 读 freq_i/q.bin 驱动, 比对 expected_tx.bin ±1LSB |

Golden model: `engineering-assets/models/comm/ofdm/` (asset_uid: `model_comm_ofdm`)。
UVM 环境: 源库另有 `knowledge/primary/domains/comm/ofdm/uvm_tb/README.md`, 指向 `docs/templates/uvm/` 的共享模板 (ofdm_uvm_pkg.sv / axi_stream_if.sv / tb_ofdm_uvm_top.sv), 未随包复制。
原仿真脚本 `knowledge/primary/domains/comm/ofdm/rtl/run_sim.do` 引用源库相对路径, 未随包复制 (避免携带失效路径)。

## 红线违规清单 (如实记录, 未修复)

1. **复位**: 全链使用异步低有效 `rst_n` (`always @(posedge clk or negedge rst_n)`), 无同步释放 — 违反"同步复位高有效 i_rst"红线。manifest 中如实声明 `active_low/async`。
   - ofdm_tx_top.sv:18, pilot_insert.sv:76/112/158, cp_insert.sv:65/91/147; mod_mapper.sv:28 用 `!rst_n` 翻转后 mapper.sv 内部为同步高有效 (仅 mapper 合规)。
2. **命名**: `clk`/`rst_n`/`cfg_*` 无 `i_`/`o_` 前缀 (ofdm_tx_top.sv:17-35, pilot_insert.sv:13-14, cp_insert.sv:15-16, mod_mapper.sv:11-12); mapper.sv 流水寄存器用 `r_*_d1` 而非 `ri_`。AXI `s_axis_*`/`m_axis_*` 及 xfft_64 的 `aclk`/`aresetn` 按标准总线例外豁免。
3. **组合直出**: `s_axis_tready` 组合直出 (mapper.sv:64-65, pilot_insert.sv:184, cp_insert.sv:176); cp_insert.sv:129-142 输出数据由组合 RAM 读直出 `m_axis_tdata`, 且 `m_axis_tvalid = output_valid && m_axis_tready` (tvalid 依赖 tready, 兼违 AXI-Stream 协议); mapper.sv:115-116 输出由 `r_` 级间寄存器而非 `ro_` 驱动。
4. **initial**: RTL 中无 initial 块 (TB 中的 initial 属正常)。
5. **锁存器**: 未发现 (组合 always 均有默认赋值/完整分支)。

## 其他显著缺陷 (评估发现, 未修复)

- **cp_insert.sv:43 `wr_bank` 无任何驱动** — 复位不赋值、永不翻转, 仿真恒 X, 乒乓机制失效 (写恒 bank A / 读恒 bank B)。
- **顶层位宽错配**: `ofdm_tx_top` 默认 `DATA_WIDTH=16`, 但 `m_axis_tdata` 语义为 32bit `{Q,I}` 打包; cp_insert 内 `{rd_i,rd_q}` 32bit 赋给 16bit 端口截断; TB 用 32bit 线接 16bit 输出。
- **mapper.sv:94 时序块内阻塞赋值** `{r_i_d2, r_q_d2} = modulate(...)` — 阻塞/非阻塞混用。
- **mapper.sv 64QAM 桩**: qam64_map 恒输出 0 (mapper.sv:176-182)。
- **pilot_insert.sv FSM 死状态**: FILL_GUARD_DC/FLUSH 声明但 next_state 永不到达; bin_cnt 递增不受握手门控 (pilot_insert.sv:91)。
- **cp_insert.sv FSM 死状态**: WRITE_SYM/DONE 不可达; s_axis_tready 引用不可达状态 (cp_insert.sv:176)。
- **TB 假绿风险**: tb_tx_top.sv:163-167 `expected_len` 声明未赋值 (恒 0) → capture 循环 0 次 → 比对 0 样点 → `errors==0` 报 PASS。当前 TB 结果不可作为通过证据。
- **TB 向量路径失配**: VEC_DIR=`../golden_model/vectors/`, 源库实际在 `ofdm/vectors/` (golden_model 平级), cosim 前需对齐。
- **向量规模失配**: TB 期望驱动 N_SYM(10)×64 样点, 向量文件仅 1 符号 (freq 64 行 / expected 80 行)。
- **xfft_64 为透传占位**: 不做 IFFT 运算, 顶层输出与 golden expected_tx.bin 不可能对齐; fidelity 只能为 pending。

## 向量健康度抽查 (2026-07-25)

expected_tx.bin: 80 行 64 唯一值; tx_i/tx_q: 80 行 63-64 唯一值; time-domain-iq.txt: 80 行 64 唯一值 — 无常量轨/全同值损坏 (rrc 曾出现的整文件坏轨未在本模块复现)。freq_i/freq_q 唯一值 5/3, 为 QPSK 星座 (±0x5A82/0xA57E/0) 的正常离散取值。
已知不一致: generate_vectors.m 注释称频域 Q2.14 但按 32767 (Q1.15) 缩放导出 — 已在 model manifest 中记录, 未修改 golden。

## 门禁

```bash
node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/intake/ofdm_tx_top
```

结果见 gate-runner 输出与 `engineering-assets/var/` 下留档。
