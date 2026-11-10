# models/comm/synch —— 参考模型状态记录

> 记录日期: 2026-07-26。全部结论来自 MATLAB R2022a 实跑, 非推测。
>
> **当前状态: L1/L2 已绿。** `run_all_tests` 5/5 PASS;
> `run_synch_sim` 可导出向量且同 seed 双跑 bit-identical。
> 本模型现在可以作为 `sync_top` 的正确性锚。
>
> 遗留一项进 L4 前必须处理: 向量只有 **370 样点**, 低于治理规范 G-B-03 的
> `total >= 2048` 下限 (与 ldpc 早先 1620<2048 同类)。需要延长采集
> (多包或加数据符号) 才能满足, 属"导出什么"的设计决定, 未擅自改。

## 1. 为什么要有这份记录

治理规范 `docs/rules/03-gates.md`: "测试和 Golden Model 是验收证据, 不是需要迎合的固定答案。
测试本身疑似错误时, 先记录失败证据、预期契约和影响范围。"

本轮为给 `incubator/intake/sync_top` 补 G-B-03 对标向量而运行本模型, 发现模型自身
无法通过它自己的验收测试。按上述规则, 先记录, 不改算法去迎合任何一侧。

## 2. 已修复(明确的机械缺陷, 不涉及算法取向)

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| F1 | `run_synch_sim.m:95` | `fprintf('...\n");` 开单引号闭双引号, **整个文件解析失败** | 改正引号 |
| F2 | `run_synch_sim.m:45` | `cfo_correct(r, eps, cfg)` 第三形参应为 `cfg.N` | 改正 |
| F3 | `packet_detect.m:21` | 滑动窗上界写成 `N_sig`, 窗内访问 `r(n+k)` (k≤L-1) 必越界 | 上界改 `N_sig-L+1` |
| F4 | `src/generate_vectors.m` | 从未被任何脚本调用; 引用不存在的 `cfg.cfo`; 输出目录相对 CWD | 接入主流程; 改 `cfg.epsilon`; 按 `mfilename` 锚定到 `vectors/`; 增导激励 |
| F5 | `tests/*.m` (5 个) | 每个测试自建一份残缺 `cfg` (缺 `short_len` 等), `generate_preamble` 直接报错 —— **5 个测试从未执行过** | 先 `config;` 再保留各自覆盖 |
| F6 | `tests/test_cfo_range.m:32`, `tests/test_timing.m:29` | 同 F2 的签名错 | 改正 |
| F7 | `coarse_cfo_est.m:25` | `r(n+k)*conj(r(n+k+N_short))` 是所需乘积的**共轭**, 估计值符号翻转; `packet_detect.m:23` 用的是相反(正确)约定, 两处不一致 | 改为 `r(n+k+N_short)*conj(r(n+k))` |

F7 的效果可量化: 主仿真 `实际=0.3000 估计=-0.3973` → 符号恢复; 回归测试
CFO 误差 **232.4% → 32.4%**; SNR 扫描误差序列 `[0.637 0.628 0.671 0.689 0.696]`
→ `[0.187 0.0405 0.0728 0.089 0.0964]` (量级回到合理区间)。

## 3. 算法层缺陷(本轮已修复, 每条附实测前后)

修完机械缺陷后 5 个测试才**可执行**, 随即暴露 4 条算法缺陷:

| # | 位置 | 问题 | 判据变化 |
|---|---|---|---|
| A1 | `coarse_cfo_est.m:25` | 相关乘积取成共轭, 估计值符号翻转 (见 F7) | 误差 232.4% → 32.4% |
| A2 | `coarse_cfo_est.m:15` | `n0=n_start+32` 起、向后 6 窗, 每窗还要访问 `n+N_short+L-1`; 实测覆盖到 263, 而短前导码只到 209 —— 后几窗落进长前导码, 那里无 16 样点周期性, 给 `angle(C)` 引入偏置 | **32.4% → 0.2%** |
| A3 | `packet_detect.m:34` | `find(M_smooth>eta,1,'first')` 取第一个越限点作平顶起点, 再要求其后 9 点全越限。平顶前只要有**一个**噪声尖峰, 起点即被钉住, 判断必败。spec §2.1 的原意是"存在长度≥9 的连续越限区间" | 检测率 85% → **100%** |
| A4 | `fine_timing.m:16` | 搜索窗按"`n_coarse` 是包起点"计算, 但 `packet_detect` 返回的是**平顶中点**(相差约半个短前导码)。实测搜 `[264,328]`, 而 T1 真值 `tau+192=242` 不在窗内, 返回窗内次优点 307 | 定时误差 65 → **1 样点** |

A4 的本质是两个函数的**契约不一致**: 一个产出平顶中点, 一个消费包起点。
修法未去猜 `n_coarse` 的语义, 而是给出必然包含 T1 的上下界。

最终: `run_all_tests` **5/5 PASS**。

```
[1/5] 包检测      PASS (检测率=100.0%)
[2/5] CFO 估计    PASS (误差=0.2%)
[3/5] 精定时      PASS (定时误差=1 样点)
[4/5] CFO 范围    PASS (范围 [-1.5,1.8], 最大误差=0.0032)
[5/5] SNR 鲁棒性  PASS (末值=0.0025)
```

## 4. 向量现状 (L2)

`vectors/` 已可生成且同 seed 双跑 bit-identical:

```
sync_stimulus.bin     370 样点  (RTL 输入激励)
expected_sync_out.bin 370 样点  (CFO 校正后期望)
vector_config.txt     EPSILON=0.300000  EPS_EST=0.297556
                      N_PEAK=119  N_FINE=243  (真值 tau+192=242)
```

**未决**: 370 < G-B-03 的 `total>=2048` 下限。要么延长采集(多包/加数据符号),
要么在规范里为本类资产另立判据。属"导出什么"的设计决定, 未擅自改。

## 5. 影响范围

- `models/comm/synch` 现在可作为 `sync_top` 的正确性锚 (L1/L2 绿)。
- `incubator/intake/sync_top` 自身仍有 25 条缺陷 (含主功能信号
  `fft_window_start` 从未置 1、T1 系数表与真实前导码相关性仅 0.179、
  CORDIC 角度表整体差 2 倍、复位极性与命名红线), 需按 L3→L4 顺序处理。
  其中 T1 系数表应由本模型导出而非在 RTL 里硬编码。
- 本记录不影响 `models/comm/ldpc`(已验证 bit-true) 与 `models/comm/rrc`(已认证)。
- `models/comm/channel_est` 已按 ADR-002 完成改造并 certified;
  `models/comm/ofdm` 仍卡在 L1, 见各自记录。

## 6. ADR-003 实施记录 (2026-08-01, sync_top 0.2.0 因果化 + cosim 闭环)

- **§4 未决项已裁决** (ADR-003): 向量延长取"加数据符号"——`run_synch_sim`
  追加 28 个 QPSK-OFDM 数据符号 (CP16+64), 总长 2610; 期望 = 总长 - 延迟
  384 = **2226 行 >= 2048**, G-B-03 下限满足。
- `src/generate_vectors.m` 重写为 **sync_top RTL 帧级位真镜像** (整数语义
  与 rtl/ 逐字对应, 含检测递推/平顶最短 64/S_cfo/CORDIC/NCO ±π回绕/K 预
  缩放/14 级旋转/符号量化相关 + 后继判别 T2 防错锁/延迟 384); 同时导出
  T1 符号量化系数表 `t1_sign_coeffs.txt` (§5 "T1 系数表应由本模型导出"
  已落实, cosim 逐位核对 RTL localparam)。
- **cosim 实证** (ModelSim 10.6c): sync_top 0.2.0 **2226 样点 0 失配
  bit-true PASS**, fft_start 对齐镜像 n_fine=242=真值; 镜像自证
  eps_est=0.3026 (真值 0.3), 平顶 [68,215]。镜像+cosim 联合暴露并修复
  RTL/镜像协同缺陷 4 处 (爬升段瞬态假平顶/T2 判别器 GI2 混叠余量/
  校正使能两拍空窗/MATLAB 负索引), 均双侧同步修。
- **观察 (未改浮点)**: 本模型 `fine_timing` 对 T1/T2 (同波形) 存在
  ±64 样点峰值模糊 —— 残余 CFO 下噪声破平, 本次延长流实测浮点链
  n=307 (真值 243, 1-based)。浮点链无防错锁, RTL/镜像用后继幅度判别
  (`|R(pk+64)|² >= |R(pk)|²/4` ⇒ pk 即 T1)。修浮点属独立决策, 未擅动。
- `incubator/intake/sync_top` §5 所列 25 条缺陷已随 0.2.0 架构重排整体
  消灭 (ADR-003, 见该包 CHANGELOG)。
