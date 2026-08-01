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

## 4. 已知问题 (未改, 待 ADR-004 阶段3 镜像改造一并处理)

- `src/generate_vectors.m` 频域激励量化用 **×32767** 却注释称 Q2.14 —
  RTL 契约 Q2.14 应为 ×16384; 期望输出为浮点 golden 直接量化, 非 RTL
  位真镜像 (±1 LSB 容差判卷, 不满足 G-B-03 0 容差标准)。整体重写排期在
  `ofdm_tx_top` RTL 定形后。
- `vectors/` 现存文件按旧 (单符号 bug) 语义生成, **作废待重导**
  (N_SAMPLES=80 即 G1 缺陷的直接物证)。
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
