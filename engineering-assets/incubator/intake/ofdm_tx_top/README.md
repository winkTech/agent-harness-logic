# ofdm_tx_top — OFDM 发射机 (intake 评估性打包)

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
| `rtl/ifft64_sdf.sv` | **自研 64 点流水 IFFT** (R2-SDF, DIF, 共轭旋转因子)，输出位反序 + `o_idx` |
| `rtl/tx_cp_insert.sv` | CP 插入: 按 `bitrev(o_idx)` 写地址吸收重排（零额外延迟），乒乓，80 拍/符号 |
| `tb/tb_tx_top.sv` | 定向自检 TB (`tb_ofdm_tx_top`)，TB 内浮点参考比对，不依赖外部向量文件 |
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

`run.do` / `run_xsim.sh` 跑同一个 `tb_ofdm_tx_top`，判据一致：

| 场景 | 内容 | 结果 |
|:-----|:-----|:-----|
| T1–T4 | BPSK/QPSK/16QAM/64QAM 各 3 符号，与 TB 内浮点参考（RTL 量化星座 → 网格 → DFT/8 → CP → Q3.13）比对 | 各 240 样点 **±4 LSB 内** |
| T1–T4 | `m_axis_tlast` 于每符号第 80 拍 | 逐符号对齐 |
| T5 | QPSK 帧 + 随机 `m_axis_tready` 反压，与无反压基准对比 | 240 样点**逐点一致**（信用节流不丢不重） |
| 断言 | `tx_pilot_map` 乒乓不变量：收集侧永不写入正在流出的 bank | 全程未触发 |

证据（2026-08-01，Vivado xsim 2023.1）: `ALL TESTS PASSED`。

## 综合结论（OOC，xc7k325tffg900-2，Vivado 2023.1）

`node engineering-assets/tools/pg-synth.cjs <包目录>` 产出，0 Errors / 0 Critical Warnings。

| 指标 | 预算 | 实测 | |
|:-----|-----:|-----:|:--|
| WNS @ 10ns | ≥ 0 | **4.318 ns** | 达成 Fmax **176 MHz**，目标 100 MHz 有 76% 裕量 |
| WHS | ≥ 0 | 0.144 ns | 失败端点 0 |
| LUT | 3500 | 1264 | 含 336 LUT as Memory（176 DRAM + 160 SRL） |
| FF | 4000 | 1099 | |
| BRAM | 4 | **0** | 4 组 64×32b 乒乓 RAM 全部映射为分布式 RAM/SRL —— 该容量下属合理选择，非推断失败；如需占 BRAM 须显式加 `ram_style` |
| DSP48E1 | 20 | **20** | **零裕量**，见 L6 |

**工具说明**: 0.2.0 的证据由 xsim 产出 —— 当时本机 ModelSim 10.6c 的 vish/vsim 回环 RPC
故障（IPv6 `::1` 可 bind 不可 connect），任何设计都无法加载；`vlog` 编译侧不受影响，
G-A-00 仍由 ModelSim 判读。两条通路互为交叉验证。

## 遗留缺陷 / 未验证项

| 编号 | 位置 | 问题 |
|:-----|:-----|:-----|
| L6 | `rtl/ifft64_sdf.sv` | **DSP 实测 20 个，正好顶满预算 20，零裕量**。事前按「级 1–4 各 1 个复乘 × 4 实数乘」估为 16，多出的 4 个尚无实证解释（推测复乘后的 36 位加法未被 DSP 后加器吸收，**未验证**）。需先查清归属再决定是抬预算还是改写乘加结构 |
| L2 | 全包 | **无 bit-true cosim 证据**：当前判据是 TB 内浮点参考 ±4 LSB，未与 golden `generate_vectors.m` 做逐位镜像比对（G-B-03 未过，`fidelity` 仍为 `pending`） |
| L3 | `tx_pilot_map.sv` | 导频极性只按符号序 ±1 交替，与 802.11a 的 127 长 PRBS 导频扰码序列不符（沿用 0.1.0 F6，需算法决策） |
| L4 | `ofdm_tx_top.sv` | `s_axis_tready` 为寄存输出，反压恢复有 1 拍气泡；如需零气泡须在边界外套 skid buffer（接口架构改动） |
| L5 | `tb/tb_tx_top.sv` | 每帧固定 3 符号、单一 LCG 种子；缺最小/最大帧长、帧间间隙、运行中复位场景（G-C-05 未过） |

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
