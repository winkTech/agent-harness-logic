# comm 模块族认证差距清单

> **文档性质变更（2026-08-01）**
>
> 本文档 2026-07-26 建立时，是 `ofdm_tx_top` / `ldpc_codec` / `sync_top` /
> `channel_est_top` 四个 comm 模块的差距清单（当时三个 reference、一个 intake）。
> 至 2026-08-01，**四族全部 certified，原清单条目全部还清**；同时 8 个原语的
> `manifest.requirement_ref` 指向本文件，故**保留路径不变**，内容改为
> 「原差距还清对照 + 全库当前剩余差距」。原版本见 git 历史。
>
> 数据来源标注：【实测】= 工具输出（gate-runner / pg-synth / xsim / report_cdc /
> asset-audit）；【文档】= 资产 manifest 的 signoff 与 limitations。
> **全文不含静态阅读得出的未验证结论** —— 原版本中标注为【观察】的条目，已随
> 四族认证被实测取代或证伪。

---

## 1. 原清单还清对照（comm 四族）

| 模块 | 原状态（2026-07-26） | 当前【实测】 | 综合实测【实测】 |
|:---|:---|:---|:---|
| `ofdm_tx_top` | reference，卡 intake 级 G-A-02；6 门阻塞、10 条红线违规 | **certified 1.0.0** | 272 MHz@100；LUT 1211/3500、FF 956/4000、BRAM 0/4、DSP 10/12 |
| `ldpc_codec` | intake（4 族最高）；6 门阻塞、5 处 `initial` | **certified 1.0.0** | 198 MHz@100；LUT 410/900、FF 244/500、BRAM 3/3、DSP 0/0 |
| `sync_top` | reference；7 门阻塞、含 2 处编译错误（全库唯一 G-A-00 FAIL） | **certified 1.0.0** | 198 MHz@100；LUT 6705/8000、FF 4669/5500、BRAM 1.5/3、DSP 16/20 |
| `channel_est_top` | reference；7 门阻塞、5 条红线 | **certified 1.0.0** | 188 MHz@100；LUT 653/900、FF 611/750、BRAM 0.5/2、DSP 8/20 |

原 §3.2「共性问题」的还清情况：

| 原共性问题 | 还清方式【实测】 |
|:---|:---|
| G-B-03 四族全 blocked（无 cosim 证据） | 四族均已产出 `alignment-report.json`。ofdm 2560 样点、sync 2226 样点，均 **0 容差 0 失配** |
| G-C-01 / G-C-02 未接线（无 STA / util） | 四族均有 XDC + `pg-synth` 实跑的 `timing-summary.rpt` / `utilization.rpt` / `envelope-check.json`，资源全部在包络内 |
| G-SIGN-01 无 signoff | 四族均有 `signoff.by=lihan` + 证据复核清单 + 已接受限制 |
| 复位风格债（3/4 异步低有效无同步释放） | 四族已统一为同步高有效 `i_rst` |
| 命名债（4/4 无 `i_`/`o_` 前缀） | G-A-02 四族全绿（AXI 协议名豁免已计） |
| golden 向量缺失/损坏（3 包缺失） | `model_comm_ofdm` 1.2.0 位真镜像重导（800 样点）；`model_comm_synch` 1.1.0、`model_comm_channel_est` 1.2.0 已入库 |
| 原 §3.2「门禁工具自身缺口」 | 已在后续 gate-runner 迭代中处理；本轮另补 `evidence-snapshot` 白名单收 `cdc.rpt` 等 CDC 原始报告 |

> **`ofdm_tx_top` 的一条单独记录**：其 0.2.0 的 IFFT 实为基-2 SDF，与 ADR-004
> 明文指定的 **R2²SDF** 不符 —— 该偏离同时是"DSP 顶满 20/20 零裕量"的根因。
> 0.3.0 对齐架构后 DSP 20→10、Fmax 176→272 MHz。这是"照着需求查实现"而非
> "照着实现改需求"的一次实例，详见该包 CHANGELOG 与 `fixed_point_report.md` §2.2。

---

## 2. 全库当前状态【实测】

- 资产 **23**：certified **16**、golden-model 7（intake 4 / qualification 3）
- `catalog-gen`: red=0 yellow=0
- `asset-audit`: **RED=0 YELLOW=0**（2026-08-02；此前 YELLOW 13，明细与还清见 §3）
- `evidence-snapshot --verify-all`: 15 份快照，2026-08-02 起
  `ldpc_codec/1.0.0` 有 1 个文件失配（见 §3.3 末注）；`rrc_polyphase_fir`
  **本就没有快照** —— 它是 16 个 certified 中唯一 `evidence_ref` 指向可再生的
  `var/gates/pg/` 而非哈希锁定目录的资产
- `incubator/intake/`: **已清空**

certified 16 = comm 四族 4 + 原语 9（`axis_skid_buffer`、`lfsr_gen`、`crc32`、
`complex_multiplier`、`delay_line`、`sdp_ram`、`frame_sync`、`cdc_sync`、
`ddr_axi4_controller`）+ 早期三件（`rrc_polyphase_fir`、`pulse_merge`、
`stream_elastic_pipeline`）。

---

## 3. 当前剩余差距

### 3.1 golden 模型侧

**2026-08-02 已还清**：

| 资产 | 原遗留项 | 复核结论【实测】 |
|:---|:---|:---|
| `model_comm_ldpc` | `exported-vectors` | **台账滞后，非向量缺失**。向量早在 2026-07-27（`9ee52f9`）就已入库，`vectors/` 现有 31 个 `.hex`，TB 经 `+VEC_DIR` 直接读取，`ldpc_codec` 1.0.0 的 G-B-03 即以此取证 |
| `model_comm_ofdm` | `exported-vectors` | 1.2.0 位真重导已完成，`tx_bits.hex` / `expected_tx.hex` 在库 |
| `model_comm_ldpc` | 8 处 `sha256` 失配 | 逐个查清后刷新：6 个（`run_all_tests.m` / `run_ldpc_sim.m` / `tests/*.m`×4）**内容从未改动**，是登记时用了原始字节而校验方用 LF 归一化，属**登记口径不一致**；2 个（`gen_rtl_test_vectors.m` / `src/ldpc_decoder_ms_fixed.m`）确在 `9ee52f9` 有实质改动（向量扩至 10 组 + 定点可达性筛选；译码器加 `nargout>2` 的纯观测 trace），当时漏登记 |
| `model_comm_rrc` | `native-matlab-recheck` | **已在本机 MATLAB R2022a 跑完**，见下 |

#### `model_comm_rrc` 复核结果 —— 结论与原诊断相反

原台账写的是"**原始导出损坏**（2048 行全为 `00008001` 负裁剪轨），已由
`tools/regen-vectors.cjs` 按 golden 语义复算再生"。原生 MATLAB 复核推翻了后半句：

- **A 系数**：`rrc_coeff_gen(cfg)` 与 `rrc_coeff.hex` **33/33 逐位一致，0 LSB 偏差**
- **B 向量**：按需求侧定点语义（实部/虚部各自裁剪）走 golden 代码路径，与
  `expected_tx.hex` **2048 样点 × I/Q = 4096 个 int16 全部逐位一致**
  → 再生向量正确，`native-matlab-recheck` **可以关闭**
- **C 关键发现**：直接调用未改动的 `rrc_pulse_shaping.m`，输出**恰好等于那份
  "损坏"文件**（4096/4096 完全相同）。所以它**不是导出损坏，是 golden 自身的缺陷**

缺陷位于 `models/comm/rrc/rrc_pulse_shaping.m:42`：

```matlab
y_quant = min(max(y_quant, -max_q/scale), max_q/scale);   % y_quant 是复数
```

MATLAB 的 `min`/`max` 对**复数**按**模**比较并返回元素本身。本例中每个样点
`|y| ≤ 0.918`，而界 `|±1.99994|` 更大 —— 于是 `max` 对每个元素都返回那个标量，
**整条信号被替换成常量 `-1.99994+0i`**（导出即 `-32767, 0`）。需求侧要求的是
Q2.14 实部/虚部各自对称裁剪 ±32767；实测该裁剪在本激励下**一次都不该触发**
（最大 `|I|=11021`、`|Q|=11294`）。

> 全库同类扫描：`min(max(` / `max(min(` 共 11 处，其余 10 处的入参均为实数
> （`channel_est/sim_channel.m:77-78` 反而是正确示范 —— 显式拆 `real`/`imag`），
> **缺陷仅此一处**。

**处置**：按"golden 与需求有出入就改 golden"的裁定，应修 `rrc_pulse_shaping.m`
的裁剪写法（依据是定点报告的需求条款，**不是 RTL 行为**）。该文件受保护，
需一次性写入令牌 —— 待办。修完后 `expected_tx.hex` 与
`expected_tx.broken-orig.hex` 的定性也要一并改写（后者不是"损坏物证"，
是"缺陷复现物证"）。

### 3.2 板级与时序收敛【registry badge_gap】

| 资产 | 遗留项 |
|:---|:---|
| `rrc_polyphase_fir` | `board-validation`、`hold-closure`（maturity_status 仍为 internal-validation） |
| `stream_elastic_pipeline` | `board-validation` |
| `pulse_merge` | `board-validation`、`upstream-commit-unpinned` |

**全库共性**：所有 certified 资产的时序/资源均为 **OOC 口径**（仅 `create_clock`，
未做布局布线与 I/O 绑定），集成到完整顶层后需重新评估。**板级验证全库为空白。**

### 3.3 文档与标记补齐【asset-audit A2/A4】—— 2026-08-02 已还清

`ldpc_codec` 与 `rrc_polyphase_fir` 的 `docs/limitations.md`（17 条 / 12 条）与
`asset-status` marker 已补齐，`asset-audit` 从 **YELLOW 13 降到 0**。

补齐过程中顺带改掉三处 README 与机器事实不符的陈述（均属实质错误，非措辞）：

- `ldpc_codec` 概要表把编码算法写成"双对角回代" —— 该实现 2026-07-31 已因
  对非全零信息位 `H·c≠0` 被废弃，现为 **PT 列累加**
- `ldpc_codec` 包结构注"`run_sim.do` 路径为源库旧布局，未改" —— 同日已修
- `ldpc_codec` 门禁状态段仍指向 `incubator/intake/` 旧路径

`rrc_polyphase_fir` 的 README §7 改为指向 `docs/limitations.md`，只留摘要，
避免两份清单各自漂移。

> 补 `docs/limitations.md` 会让 G-DOC-04 的 `detail` 字段变化，
> `evidence/ldpc_codec/1.0.0/` 快照因此出现 **1 个文件失配**（34 选 1，
> 其余 33 个逐字节相同）。这是补文档的直接后果，**处置方式待 owner 裁定**：
> 在 1.0.0 原地重取快照，还是升到 1.0.1 并保留 1.0.0 的签署原貌。

### 3.4 已签署接受的接口/语义偏离（非缺陷，集成方必读）

摘自各包 `docs/limitations.md`【文档】：

- `ofdm_tx_top`：导频极性按符号 ±1 交替，**非 802.11a 的 127 长 PRBS 扰码**
  （与 golden 同约定，全族简化，升级需两族同步）
- `sync_top`：**无反压契约**，`m_axis_tready` 被忽略；单突发语义
- `frame_sync`：`i_valid` 是**载波有效**（GMII `rx_dv` 语义），不是可气泡的流
  valid —— 直接接带气泡的 AXI-S valid 会把帧切碎
- `sdp_ram`：**read-old** 同址语义；阵列不复位、上电为 X，须先写后读
- `cdc_sync`：**亚稳态无法被仿真或综合报告证明**；两域必须联合复位；
  高吞吐跨域应改用异步 FIFO
- `ddr_axi4_controller`：**超时时撤回已置位的 AXI valid，严格 AXI 不允许**
  （仅作 MIG 挂死恢复路径）；**未与真实 MIG 联调**
- `complex_multiplier`：**全精度输出不做舍入/饱和**，定标语义交调用方
- `delay_line`：数据链刻意不复位（为 SRL 推断），复位后保留旧值

---

## 4. 本轮沉淀的共性经验

以下五条来自 2026-08-01 的实际教训，对后续资产准入有直接价值：

1. **静态门全绿 ≠ 被验证过。** `ddr_axi4_controller` 自入库起 G-B-03 一直
   blocked（`tb-selfcheck.json` 从未生成），"qualification" 全靠 G-A-*/CS-*
   这些静态门拿到。强制要求实跑证据才把它翻出来 —— 首跑即 FAIL。
   **推论**：任何资产的 README 若声称"验证通过"，必须能指向具体证据文件。

2. **资源预算必须事前按结构推算，不能拿实测反推。** 本轮 9 个原语全部先推算
   后实测，多数完全吻合（`crc32` FF 75/75、`delay_line` 66/66、`frame_sync`
   27/27、`sdp_ram` 53/53、`cdc_sync` 24/24、`ddr` 1619/1616）。吻合本身就是
   "设计与理解一致"的证据；不吻合时（`ofdm_tx_top` DSP 20 vs 推算 16）必须查到
   原因，**不留"未解释"**。

3. **推断核查要当作硬判据。** `complex_multiplier` 的 DSP 必须为 4（为 0 即
   乘法器推断失败）、`sdp_ram` 的 BRAM 必须非 0（该模块存在的目的就是 BRAM
   推断）。反过来 `delay_line` 默认参数下 SRL=0 是**预期**（`P_DELAY=2` 无中间
   链），不能据此判失败 —— 预期值要写进 `note_budget`。

4. **等价判据必须写明映射，不得冒充。** 无 ready 接口的原语（`lfsr_gen` /
   `crc32` / `delay_line` / `sdp_ram` / `frame_sync`）的 G-C-05 `backpressure`
   子结果，一律在证据 `reason` 里写明"本原语无反压接口，此处取证的是 XX 等价
   性质"；有真实反压的（`cdc_sync` 的 `o_ready_src`、`ddr` 的 AXI）才直接判。
   同理 `cdc_sync` 的 8 条 CDC-15 Warning **如实保留、不豁免、不声称 clean**，
   逐条给出协议层安全论证。

5. **TB 驱动 DUT 输入必须在 negedge。** `ddr_axi4_controller` 的从机模型在
   posedge 之后用阻塞赋值改 `rvalid`/`rdata`/`rlast`，与 DUT 的
   `always_ff @(posedge)` 同时间步、执行顺序不定 —— 表现为末拍错位与数据移位
   一拍，**险些被误判为 RTL 缺陷**。四步实验（独立探针 / 原始 TB / 关反压 /
   改 negedge）才定位清楚。同类"仿真语义细节导致的静默错误"另见
   `docs/rules/01-hdl.md` 硬约束 8（NBA 左值下标禁止函数调用）。

---

## 5. 结论来源分类

| 类别 | 本文档中的来源 |
|:---|:---|
| 工具实测 | `gate-runner`（级别判定）、`pg-synth`（时序/资源）、`xsim`（自检与 cosim）、`report_cdc`（cdc_sync）、`asset-audit` / `catalog-gen` / `evidence-snapshot --verify-all` |
| 资产声明 | 各包 `manifest.signoff.scope` 与 `docs/limitations.md` |
| 治理台账 | `integration/registry.json` 的 `issues` / `badge_gap` / `maturity_status` |

证据留档：`engineering-assets/var/gates/pg/<asset_uid>/`（实时）与
`engineering-assets/evidence/<asset_uid>/<version>/`（哈希锁定快照）。
