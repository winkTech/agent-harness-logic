# models/comm/ofdm —— 参考模型状态记录

> 首份记录: 2026-08-01。全部结论来自 MATLAB R2022a 实跑, 非推测。
> **当前状态: L1 绿。** `run_all_tests` **3/3 PASS** (修复前首次实跑 **0/3**)。

## 1. 首次体检 (2026-08-01, ADR-004 启动时)

本模型此前无状态记录; 为推进 `ofdm_tx_top` 认证首次实跑:

```
[1/3] BER测试(理想信道)   FAIL  数组的大小不兼容
[2/3] 多调制方式测试      FAIL  数组的大小不兼容
[3/3] 边界条件测试        FAIL  单频输入: false
```

## 2. 根因与修复 (每条附实测前后)

| # | 位置 | 问题 | 判据变化 |
|---|---|---|---|
| G1 | `src/tx_chain.m` | `mod_mapper` 返回列向量 [N_data·N_sym×1], 而 `subcarrier_map` 按 [N_data×N_sym] 消费 (`size(...,2)` 当符号数) — **10 符号帧只产出 1 个符号** (80 样点而非 800) | 补 `reshape(..., N_data, N_sym)`; 时域输出 80→800, BER 报错→0 |
| G1b | `src/tx_chain.m` | 比特数信任 `cfg.mod_order` (默认 2), 而测试只改 `mod_type` — BPSK 960 比特映出 960 符号 ≠ 48×10 (G1 修复后暴露) | 阶数从 `mod_type` 单一事实源推导; 四调制 BER 全 0 |
| G2 | `tests/test_boundary.m` | DC 激励写在第 33 位 ("FFT shift 后位置") — `ifft_chain` 契约是**自然序** (DC 在位置 1, 其头注释 2026-06-03 明文修订), 第 33 位实为 Nyquist bin, 时域 ±交替非直流 | `freq_dc(1)=1`; 单频测试 false→true |

修复后:

```
[1/3] BER测试(理想信道)   PASS  BER = 0
[2/3] 多调制方式测试      PASS  BPSK/QPSK/16QAM/64QAM BER 全 0
[3/3] 边界条件测试        PASS  全零/单频均过
```

RX 侧 (`rx_chain`/`mod_demapper`) 四调制 Gray 映射与硬判决逐一手工核对,
数学正确, 未改。

## 3. 契约裁决 (ADR-004, 2026-08-01)

- **导频极性锚** = 本模型 `subcarrier_map` 现行契约: `pilot_val=[1,1,1,-1]`,
  逐符号 ±1 交替 (首符号 +)。802.11a 127 长 PRBS 扰码为**已知简化**
  (与 channel_est 族固定导频假设同类目), 升级时全族同步。
- IFFT 语义: `ifft_chain` = MATLAB 自然序 `ifft(x)·sqrt(N)`
  (Parseval 功率一致); RTL 位真镜像按此标定逐级缩放。

## 4. 已知问题

### 4.1 已结案 (2026-08-01, ADR-004 阶段3 执行完毕)

- ~~`src/generate_vectors.m` 频域激励量化用 **×32767** 却注释称 Q2.14~~ —
  **已修**: 频域改由 `rtl_mirror_tx` 按 config.m 声明的 Q2.14 (×16384) 产出。
- ~~期望输出为浮点 golden 直接量化, 非位真镜像 (±1 LSB 容差, 不满足 G-B-03)~~ —
  **已修**: 1.2.0 新增 `src/rtl_mirror_tx.m` 定点位真镜像, 期望值改由其产出,
  判卷改为 **0 容差**。激励层级同时由频域中间量改为**比特流**, 与 DUT 入口
  对齐 (原比对两侧不同层, 语义本就不成立)。
- ~~`vectors/` 按旧单符号语义生成, 作废待重导~~ — **已重导**: 800 样点
  (10 符号 × 80)。当前有效文件 `tx_bits.hex` / `expected_tx.hex` /
  `freq_grid.hex` / `vector_config.txt`; 旧 `*.bin` 与 `time-domain-iq.txt`
  按前版决定**保留作 G1 缺陷物证**, 不得用于判卷。

**实测结论**: `ofdm_tx_top` 0.3.0 与本镜像 cosim, **2560 样点 (4 调制 × 8 符号)
逐位 0 失配**, 证据 `var/gates/pg/ofdm_tx_top/alignment-report.json`。

镜像的依据方向: 结构取 ADR-004 决策1 的 R2²SDF (由 DIF 分解推导, 与 `ifft_chain`
的 `ifft(x)·sqrt(N)` 标定核对), 缩放/舍入取 `fixed_point_report` §2.2/§2.4 的
需求侧调度表 —— **不是照 RTL 写的**。该表同日由 ADR-004 阶段3 升格为需求侧单一
事实源; 此后 RTL 偏离该表即为 RTL 缺陷, cosim 失配应修 RTL。

### 4.2 未结案

- `run_ofdm_sim.m` 绘图分支 `saveas(...,'results/...')` 在 results/ 目录
  缺失时会报错 (不影响向量导出主流程)。
- `run_ofdm_sim.m` 第 11 行 `cfg = config;` —— `config.m` 是脚本非函数,
  该调用会报「不支持将脚本作为函数执行」。本轮重导改用 `config;` 绕过,
  原文件未改 (不在 ADR-004 阶段3 授权范围内)。
- `cfg.mod_order` 字段与 `mod_type` 冗余且易失一致 (G1b 教训), tx_chain
  已不再消费; 字段保留待 config 清理。
- `run_ofdm_sim.m` 绘图分支 `saveas(...,'results/...')` 在 results/ 目录
  缺失时会报错 (不影响向量导出主流程)。
- `cfg.mod_order` 字段与 `mod_type` 冗余且易失一致 (G1b 教训), tx_chain
  已不再消费; 字段保留待 config 清理。

## 5. 影响范围

- 本模型现可作 `ofdm_tx_top` 的正确性锚 (L1 绿); L2 (向量) 待阶段3。
- `incubator/intake/ofdm_tx_top` 自身缺陷 (F1-F8, 含 IFFT 透传占位) 由
  ADR-004 裁决整体重排, 见该包 README 与 ADR。
- 与 `models/comm/channel_est` 的导频契约差异记录: 本模型 TX 导频
  [1,1,1,-1]·±交替 vs channel_est RX 假设固定 [1,1,-1,1] — 两族 golden
  各自为锚, 系统级联调时需统一 (记录, 不在本包范围)。
