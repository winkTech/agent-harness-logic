<!-- asset-status: certified v1.0.0 -->
# ofdm_tx_top — 802.11a 风格 OFDM 发射机 (certified CBB)

802.11a 风格 OFDM 发射链: 比特流 → 调制映射 → 导频/子载波映射 → 64 点 IFFT → CP 插入 → AXI-Stream 输出。
定点: 16bit, Q2.14 (频域) / Q3.13 (时域)。

> **0.2.0 (ADR-004) 已按自研 IFFT 架构整体重排**，全链首次功能贯通。
> 0.1.0 的 `mod_mapper`/`mapper`/`pilot_insert`/`cp_insert` 与 Xilinx FFT IP
> 占位模型 `xfft_64.sv` 全部作废并移出包（见 CHANGELOG 与 git 历史 490bb4f）。

## 结构

| 路径 | 说明 |
|:-----|:-----|
| `rtl/ofdm_tx_top.sv` | 顶层: tx_mapper → tx_pilot_map → ifft64_sdf → tx_cp_insert；含符号信用节流 |
| `rtl/tx_mapper.sv` | 四调制星座映射 (BPSK/QPSK/16QAM/64QAM)，与 golden `mod_mapper` 逐字对齐，2 拍 |
| `rtl/tx_pilot_map.sv` | 子载波/导频映射: 48 数据点乒乓收集 → 自然序 64 拍流出；导频极性逐符号交替 |
| `rtl/ifft64_sdf.sv` | **自研 64 点流水 IFFT** (R2²SDF, DIF, 共轭旋转因子)，完整复乘仅 2 个，输出位反序 + `o_idx` |
| `rtl/tx_cp_insert.sv` | CP 插入: 按 `bitrev(o_idx)` 写地址吸收重排（零额外延迟），乒乓，80 拍/符号 |
| `tb/tb_tx_top.sv` | 定向自检 TB (`tb_ofdm_tx_top`)，TB 内浮点参考比对，不依赖外部向量文件 |
| `tb/tb_tx_cosim.sv` | **位真 cosim TB**：与 golden 镜像逐位比对，**0 容差**，产出 `alignment-report.json` |
| `tb/gen_cosim_vectors.m` | cosim 向量组装（调用 golden 的 `rtl_mirror_tx`，本身不含镜像逻辑） |
| `run.do` | ModelSim 入口（构建落 `var/build/`） |
| `run_xsim.sh` | Vivado xsim 入口（同一 TB、同一判据） |

Golden model: `engineering-assets/models/comm/ofdm/` (asset_uid: `model_comm_ofdm`)。

## 接口契约

- `s_axis_tdata[5:0]` = 一个星座符号的比特组（LSB 对齐，b0 = 码流首比特）；每 48 拍构成一个 OFDM 符号；`s_axis_tlast` 未用（帧语义在外部）
- `i_cfg_mod_type[1:0]`: 0 BPSK / 1 QPSK / 2 16QAM / 3 64QAM，**帧内须稳定**；高 2 位保留
- `m_axis_tdata` = `{Q3.13_Q[15:0], Q3.13_I[15:0]}`（32 位），`tlast` 于每符号第 80 拍
- **符号信用节流**: 在途符号 ≤2（CP 乒乓深度）；新符号首拍需信用，符号中途 48 拍保证连续接受
- **尾部冲刷**: 流结束后需再馈 ≥2 个全零符号排空 IFFT 流水（TB/集成契约）
- 0.1.0 的 `i_cfg_fft_len` / `i_cfg_cp_len` 从未被消费，已删除（原 F1）

## 验证现状

```bash
bash engineering-assets/incubator/intake/ofdm_tx_top/run_xsim.sh
```

判据 = TB 内浮点参考 ±4 LSB。参考由 TB 独立按算法定义重算（RTL 量化星座 → 网格 →
DFT/8 → CP → Q3.13），不读 RTL 输出、不依赖外部向量文件。

| 场景 | 内容 | 结果 |
|:-----|:-----|:-----|
| **R** regression | 四调制（BPSK/QPSK/16QAM/64QAM）各 3 符号 | 各 240 样点 ±4 LSB，tlast 逐符号对齐，失配 **0** |
| **B** boundary | 最小帧 1 符号 / 最大帧 8 符号 / 输入侧随机 0–3 拍空隙流 | 80 + 640 + 240 样点，失配 **0**（空隙流通过即证明各级计数受握手门控） |
| **P** backpressure | 4 种 `m_axis_tready` 模式：随机 75%、周期 4 低 4 高、每 200 拍长拉低 50、逐拍翻转 | 各 240 样点与无反压基准**逐点一致**，差异 **0** |
| **S** stress | 12 帧连续满吞吐，帧间轮换四种调制 | 2880 样点，失配 **0** |
| **X** reset | 帧中复位保持 3 拍 → 39 个受复位寄存器逐个比对声明值 → 复位后重入新帧 | 寄存器失配 **0**，重入失配 **0** |
| 常驻断言 | `tx_pilot_map` 乒乓不变量：收集侧永不写入正在流出的 bank | 全程未触发 |

证据（2026-08-01，Vivado xsim 2023.1）: `ALL TESTS PASSED`。JSON 证据由 TB 自身
`$fwrite` 产出（非人工填写），落 `var/gates/pg/ofdm_tx_top/` 的 `stability/*.json`
与 `reset-sim.json`，对应门禁 G-C-05 / G-C-04。

### 位真 cosim（G-B-03）

`tb_tx_cosim` 与 golden `models/comm/ofdm/src/rtl_mirror_tx.m` 逐位比对，**0 容差**：

| 帧 | 调制 | 样点 | 逐位失配 |
|:--|:--|--:|--:|
| 0 | BPSK | 640 | **0** |
| 1 | QPSK | 640 | **0** |
| 2 | 16QAM | 640 | **0** |
| 3 | 64QAM | 640 | **0** |

合计 2560 样点（门禁下限 2048）。实测流水延迟 195 拍，比对按 valid 握手对齐、
无人工偏移。`fidelity: bit_true`。

镜像与 RTL 是**各自照 `fixed_point_report` §2.2 的需求侧调度表独立实现**的，
不是一方照抄另一方 —— 首次运行即逐位相等。该表是单一事实源：RTL 偏离它即为
RTL 缺陷，cosim 失配应修 RTL，不得改镜像或该表去迁就实现。

## 综合结论（OOC，xc7k325tffg900-2，Vivado 2023.1）

`node engineering-assets/tools/pg-synth.cjs <包目录>` 产出，0 Errors / 0 Critical Warnings。

| 指标 | 预算 | 实测 | |
|:-----|-----:|-----:|:--|
| WNS @ 10ns | ≥ 0 | **6.323 ns** | 达成 Fmax **272 MHz**，目标 100 MHz 有 172% 裕量 |
| LUT | 3500 | 1211 | 含 LUT as Memory（分布式 RAM + SRL） |
| FF | 4000 | 956 | |
| BRAM | 4 | **0** | 4 组 64×32b 乒乓 RAM 全部映射为分布式 RAM/SRL —— 该容量下属合理选择，非推断失败；如需占 BRAM 须显式加 `ram_style` |
| DSP48E1 | 12 | **10** | R2²SDF 的 2 个完整复乘；预算按 2×4+裕量 事前推导 |

**工具说明**: ModelSim 通路已停用（本机 vish/vsim 回环 RPC 故障：IPv6 `::1` 可 bind
不可 connect，任何设计都无法加载）。全部仿真证据由 xsim 产出；`vlog` 编译不开 socket
不受影响，G-A-00 仍由 ModelSim 判读。`run.do` 保留但未在本版验证中使用。

## 遗留缺陷 / 未验证项

| 编号 | 位置 | 问题 |
|:-----|:-----|:-----|
| ~~L6~~ | — | **已关闭（0.3.0）**：DSP 零裕量的根因是 IFFT 用了基-2 SDF 而非 ADR-004 指定的 R2²SDF，乘法器多一倍。对齐架构后 DSP 20→10 |
| ~~L2~~ | — | **已关闭（0.3.0）**：与 golden `rtl_mirror_tx` 位真 cosim，2560 样点（4 调制 × 8 符号）**0 容差逐位相等**，`fidelity` 已升为 `bit_true` |
| L3 | `tx_pilot_map.sv` | 导频极性只按符号序 ±1 交替，与 802.11a 的 127 长 PRBS 导频扰码序列不符（沿用 0.1.0 F6，需算法决策） |
| L4 | `ofdm_tx_top.sv` | `s_axis_tready` 为寄存输出，反压恢复有 1 拍气泡；如需零气泡须在边界外套 skid buffer（接口架构改动） |
| L5 | `tb/tb_tx_top.sv` | 帧长仅覆盖 1/3/8 符号，激励为单一 LCG 序列；无随机约束/覆盖率收集，最大帧长未探到设计上限 |

### 已在 0.2.0 修复的 0.1.0 缺陷

F1（cfg 端口未消费）、F2/F3/F4（`cp_insert` 乒乓未实现 / 计数位宽不足 / FSM 死状态）、
F5（`pilot_insert` 计数不受握手门控）、F7（64QAM 桩恒 0）、F8（FFT IP 占位不做运算）
—— 均随架构重排消除。F6 → L3 保留。

### 工具相关约束

`tx_pilot_map` / `tx_cp_insert` 的 RAM 写地址必须先经 `assign` 落到 wire 再做下标，
不可直接把函数调用写进非阻塞赋值的左值下标 —— ModelSim 10.6c 会用该变量**自增后**的值
（违反 IEEE 1800 §10.4.2 的 active 区求值）。已实测：该写法在 ModelSim 10.6c 上错、
在 xsim 2023.1 上对，属仿真/仿真间不一致，代码内已注明。

## 门禁

```bash
node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/intake/ofdm_tx_top
```

结果见 gate-runner 输出与 `engineering-assets/var/gates/pg/ofdm_tx_top/` 留档。
