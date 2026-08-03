# CHANGELOG — ofdm_tx_top

## [1.0.1] — 2026-08-02 声明证据复现入口（G-GATE-02）

manifest 新增 `reproduce` 字段，把"证据怎么重做"从 README 里的散文变成**机器可校验
的契约**。新门 `G-GATE-02` 校验该命令引用的脚本在仓库中真实存在。

动因：`G-GATE-01` 只查证据文件在不在，普查发现 16 个 certified 里 14 个的证据当时
无法被任何人重新生成，**却全都通过了 G-GATE-01**。

RTL、约束、TB、证据零改动；升 patch 版仅因 manifest 内容变化会使快照的
`manifest_sha256` 失配，按库内既定做法升版重取。

## [1.0.0] — 2026-08-01 certified 认证

内容与 0.3.0 一致，无代码改动；本条为认证记账：

- G-SIGN-01：owner lihan 具名签署（manifest.signoff，含证据复核清单与
  6 组已接受限制 + 工具说明）。
- gate-runner **20/20 全绿，达到 CERTIFIED**；证据快照
  `evidence/ofdm_tx_top/1.0.0/SNAPSHOT.json`（哈希锁定并 verify 通过）；
  包迁入 `cbb/`；新增 `docs/limitations.md`。
- registry ITG-0008 repin 1.0.0，maturity_status → certified，
  三项 badge_gap（fft-contract / bit-true-vectors / vivado-timing）全部还清。
- 全流程：0.1.0 编码整改 → 0.2.0 自研 IFFT 架构重排（首次功能贯通，修
  NBA 左值索引与信用回绕两缺陷）→ 0.3.0 对齐 ADR-004 的 R2²SDF（DSP 20→10，
  Fmax 176→272 MHz）→ golden 1.2.0 位真镜像 → cosim 2560 样点 0 失配 →
  证据链 → 签署，全链实跑取证。
- 库内第 6 个 certified。

## [0.3.0] — 2026-08-01 IFFT 对齐 ADR-004 的 R2²SDF；缩放调度升格为需求侧决策

0.2.0 的 `ifft64_sdf` 实为**基-2 SDF**，与 ADR-004 明文指定的 **R2²SDF** 不符；
级移位为纯截断，与 `fixed_point_report.md` §2.4「truncation 不推荐」相悖。两处
均属实现偏离需求，本版改正 —— 而非反过来把需求改成迁就实现。

### 变更

- `rtl/ifft64_sdf.sv` 按 R2²SDF 重排：奇数级 BF2I / 偶数级 BF2II，平凡因子
  `j^{n1}` 乘在进入蝶形的 x 上；**完整复乘由 4 个减为 2 个**（级 2、级 4 之后）。
  旋转指数 `e = k3·(n1+2n2)`，流式组号给出的是 (n2,n1)，故组系数需两位对调
  `P=[0,2,1,3]`。旋转因子表扩至 64 项（指数域 0..45）。
- 级 2/4/6 的缩放由截断 `>>>1` 改为 **rounding** `(x+1)>>>1`。
- `fixed_point_report.md` §2.2 记录决策变更（BFP → 固定逐级右移，理由：ADR-004
  弃用 Xilinx IP 使原推荐理由失效，且 BFP 的变尺度与 golden 定尺度契约冲突、
  会使 0 容差镜像不成立），并把完整缩放调度写成需求侧单一事实源；§2.4 记录
  全部缩放点采纳 rounding。**此后 RTL 偏离该表即为 RTL 缺陷。**

### 效果（同一 TB、同一判据复测）

| 指标 | 0.2.0 (R2SDF) | 0.3.0 (R2²SDF) |
|:-----|:--------------|:---------------|
| DSP48E1 | 20 / 预算 20（零裕量） | **10** / 预算 12 |
| LUT | 1264 | 1211 |
| FF | 1099 | 956 |
| WNS @10ns | 4.318 ns（176 MHz） | **6.323 ns（272 MHz）** |

五场景（regression / boundary / backpressure / stress / reset）全部 `ALL TESTS PASSED`，
失配 0。遗留项 **L6（DSP 零裕量且多出 4 个未解释）随架构对齐关闭** —— 多出的乘法器
正是基-2 与基-2² 的结构差。

### 过程记录

结构先在 MATLAB 原型上验对（与 `ifft(x)·sqrt(64)` 偏差 3e-12）再翻 RTL，定点原型
实测最大偏差 2 LSB。RTL 首版失配 100%，根因为乘法级数据通路 3 拍而 valid 链只给了
2 拍 —— 补第三级后全通。

### 位真 cosim（同日补齐，G-B-03 / G-GATE-01 转绿）

- 新增 `tb/tb_tx_cosim.sv`：与 golden `models/comm/ofdm/src/rtl_mirror_tx.m`
  **逐位比对、0 容差**，产出 `alignment-report.json`
- 新增 `tb/gen_cosim_vectors.m`：调用 golden 镜像组装四调制向量集（本身不含
  镜像逻辑，权威在 golden）
- golden 侧同步升 1.2.0：新增位真镜像 `rtl_mirror_tx.m`；`generate_vectors.m`
  重写（激励改比特层、期望改位真、频域缩放由 ×32767 修正为 Q2.14 ×16384）；
  `vectors/` 重导为 800 样点（原 80 样点是 G1 缺陷物证，按前版决定保留）

**结果：2560 样点（4 调制 × 8 符号）逐位失配 0**，`fidelity` 由 `pending` 升为
`bit_true`。遗留项 L2 关闭。

镜像与 RTL 各自照 `fixed_point_report` §2.2 的需求侧调度表独立实现，首次运行即
逐位相等 —— 这是两侧都正确实现同一份需求的证据，而非一方迁就另一方。

## [0.2.0] — 2026-08-01 ADR-004 架构重排：自研 IFFT，全链首次功能贯通

0.1.0 只做了编码规范整改，算法/架构层缺陷（F2/F3/F4 使 `cp_insert` 根本产不出
正确 CP 符号流、F8 的 FFT IP 占位不做运算）导致全链从未功能贯通。本版按 ADR-004
整体重排数据通路。

### 新增

- `rtl/ifft64_sdf.sv` — **自研 64 点流水 IFFT**（R2-SDF，DIF，共轭旋转因子
  `W64^{-nk}`，6 级反馈延迟 32/16/8/4/2/1）。级 2/4/6 蝶形后各右移 1（净 /8），
  输出 `(x+1)>>>1` 转 Q3.13 并饱和 s16。输出位反序 + `o_idx` 供下游吸收重排。
- `rtl/tx_mapper.sv` / `rtl/tx_pilot_map.sv` / `rtl/tx_cp_insert.sv` — 重写替代
  0.1.0 的 `mod_mapper`+`mapper` / `pilot_insert` / `cp_insert`。
- `run_xsim.sh` — Vivado xsim 入口（与 `run.do` 同一 TB、同一判据）。

### 移除

- `rtl/mod_mapper.sv`、`rtl/mapper.sv`、`rtl/pilot_insert.sv`、`rtl/cp_insert.sv`、
  `tb/xfft_64.sv` —— 全部作废（内容见 git 490bb4f）。
- 顶层 `i_cfg_fft_len` / `i_cfg_cp_len` —— 从未被消费的伪配置端口（原 F1）。

### 修复（本轮定位）

- **`tx_pilot_map` 网格整体错位一格**：RAM 写地址把函数调用直接写在非阻塞赋值的
  左值下标里（`r_mem[f_bin(r_wcnt)] <= …`），ModelSim 10.6c 用了 `r_wcnt` **自增后**
  的值，违反 IEEE 1800 §10.4.2 的 active 区求值。已用 30 行最小用例锁定：同一时钟沿、
  同一 always_ff 内，`mem[f(cnt)]` 全错而 `assign w=f(cnt); mem[w]` 全对；xsim 2023.1
  下两者皆对，故属 ModelSim 特有偏差与仿真/综合不一致风险。`tx_pilot_map` 与
  `tx_cp_insert` 两处写地址均改为先经 `assign` 落 wire 再索引。
- **符号信用回绕致乒乓冲突**：顶层 `ro_tready` 由**现态**寄存推导，落后一拍。符号最后
  一拍（`r_bcnt=47` 且信用已耗尽）ready 因 `r_bcnt!=0` 仍为 1，下一拍 `r_bcnt` 已回 0 而
  ready 尚未落下，多放行一个 beat —— 2 bit 信用 0-1 回绕成 3，第三个符号提前开收，
  覆写 `tx_pilot_map` 正在流出的 bank（实测 96 拍冲突，符号 1/2 的 bin 38..63 全被污染）。
  改为由**次态** `w_credit_nxt`/`w_bcnt_nxt` 推导 ready。

### 验证

`tb/tb_tx_top.sv` 重写为定向自检，不再依赖外部向量文件（0.1.0 的 TB 驱动硬编码比特
却比对 golden 频域中间量，语义不成立）。TB 内按「RTL 量化星座 → 网格 → DFT/8 → CP
→ Q3.13」算浮点参考。

- T1–T4 四调制各 3 符号：各 240 样点 **±4 LSB 内**，`m_axis_tlast` 逐符号对齐
- T5 QPSK + 随机反压：240 样点与无反压基准**逐点一致**
- 乒乓不变量断言（收集侧不写正在流出的 bank）全程未触发
- 结果：`ALL TESTS PASSED`（Vivado xsim 2023.1，2026-08-01）

**工具说明**：本版证据由 xsim 产出。当时本机 ModelSim 10.6c 的 vish/vsim 回环 RPC
故障（IPv6 `::1` 可 bind 不可 connect）使任何设计都无法加载；`vlog` 编译不受影响，
G-A-00 仍由 ModelSim 判读。

### 综合（同日补齐，G-C-01/G-C-02 转绿）

新增 `constraints/ofdm_tx_top.xdc`（100 MHz `create_clock`）并在 manifest 登记
`device.part = xc7k325tffg900-2` 与资源预算。预算**事先**按 `resource_estimate.md`
（2800 LUT / 3200 FF / 3 BRAM）加裕量设定，DSP 由文档的 12（Xilinx FFT IP 方案）
调到 20（自研 SDF 级 1–4 各一个复乘 = 16 + 裕量），再用实测去对。

`node tools/pg-synth.cjs`（OOC，Vivado 2023.1，0 Errors / 0 Critical Warnings）：

- WNS **4.318 ns** @ 10 ns → 达成 Fmax **176 MHz**，WHS 0.144 ns，失败端点 0
- LUT 1264/3500，FF 1099/4000，BRAM 0/4，DSP48E1 **20/20**
- BRAM=0：4 组 64×32b 乒乓 RAM 全部映射为分布式 RAM/SRL（336 LUT as Memory），
  该容量下属合理映射而非推断失败
- DSP 顶满预算零裕量，且比事前估算多 4 个，归属未查清 → 新增遗留项 L6

### 验证扩展（同日补齐，G-C-04/G-C-05 转绿）

TB 由 T1–T5 扩为五类场景，证据由 TB 自身 `$fwrite` 产出到 `stability/*.json` 与
`reset-sim.json`（非人工填写），全部由 xsim 跑出：

- **R regression** 四调制各 3 符号 → 960 样点失配 0
- **B boundary** 最小帧 1 符号 / 最大帧 8 符号 / 输入侧随机 0–3 拍空隙流 → 960 样点失配 0；
  空隙流通过即证明各级计数受握手门控（0.1.0 F5 的回归防线）
- **P backpressure** 4 种 tready 模式（随机 75%、周期 4/4、每 200 拍长拉低 50、逐拍翻转）
  → 1200 样点与无反压基准逐点一致
- **S stress** 12 帧连续满吞吐、帧间轮换调制 → 2880 样点失配 0
- **X reset** 帧中复位保持 3 拍，39 个受复位寄存器逐个比对声明值（含 `r_credit`=2），
  复位后重入新帧 → 寄存器失配 0、重入失配 0。数据通路寄存器按 §1.1/§10.2 少复位设计
  不受复位控制，排除理由写在 `reset-sim.json` 的 `method` 字段
- 乒乓不变量改为常驻硬断言，全程未触发

工具侧：**ModelSim 通路停用**（回环 RPC 故障），`run_xsim.sh` 成为唯一验证入口并
负责搬运证据到门禁位置。xsim 的 `-testplusarg` 传不了含盘符的路径，故 TB 写运行目录
再由脚本搬运；`$fwrite` 用 `%s` 输出多字节 string 会损坏内容，故 reason 文本直接写在
格式串内。

### 仍未解决

L2 无 bit-true cosim（`fidelity` 仍 `pending`）、L3 导频极性非 802.11a PRBS 扰码、
L4 反压恢复 1 拍气泡、L5 激励为单一 LCG 序列无随机约束/覆盖率、L6 DSP 用量零裕量
且比事前估算多 4 个未解释。详见 README。

## [0.1.0] — 2026-07-28 hdl-coding 规范整改

按 `docs/rules/01-hdl.md` 五条红线整改全部 RTL。**只动编码规范层面**；
算法/架构层面的遗留缺陷未改，逐条列在 README「遗留缺陷」表。

### 变更

- 复位：全链 `negedge rst_n` 异步低有效 → 同步高有效 `i_rst`；
  `mod_mapper` 原先靠 `!rst_n` 做极性翻转，现上下游极性统一，翻转取消。
- 命名：`clk/rst_n/cfg_*` → `i_clk/i_rst/i_cfg_*`；内部信号改 `ri_/ro_/r_/w_`；
  FSM 状态改 `P_` 前缀。
- 红线 1/2：`pilot_insert` / `cp_insert` 新增 `ri_` 输入寄存级；输出全部由
  `ro_` 驱动；`cp_insert` 的 RAM 读由组合直出改同步读。
- 红线 4：`pilot_insert` / `cp_insert` FSM 改三段式，`default` 齐备。
- **§5 位宽修正**：`m_axis_tdata` 声明 `[DATA_WIDTH-1:0]`=16 位却被赋值 32 位的
  `{I,Q}` —— I 路一直被静默截断。现改为 `[DATA_WIDTH*2-1:0]`，与文档声明一致。
- **AXI4-Stream 协议修正**：`cp_insert` 的 `m_axis_tvalid = output_valid && m_axis_tready`
  让 tvalid 依赖 tready，违反 AXI-S；现改为纯寄存输出，与 tready 解耦。
- **§6 阻塞/非阻塞**：`mapper` Stage2 的 `{r_i_d2,r_q_d2} = modulate(...)` 在时序
  always 块里用阻塞赋值，与同块 `<=` 混用；已改非阻塞。
- **`mapper` 数据/valid 错位修正**：原 `m_axis_i/q` 直接取 Stage2 寄存器，而
  `m_axis_tvalid` 来自再晚一拍的 `ro_valid` —— 数据比 valid 早 1 拍，下游按
  valid 采样必然取错。现新增对齐的 `ro_` 输出级。
- **`mapper` 反压数据覆盖修正**：三级流水改统一使能 `w_pipe_ce`。整改过程中实测
  发现：若只冻结输出级而让 Stage2 继续推进，Stage2 会覆盖尚未被收走的数据
  （随机反压下 72/600 拍错位）。统一使能后不丢不重。
- **文件归类**：`xfft_64.sv` 由 `rtl/` 移入 `tb/` —— 它是 Xilinx FFT IP 的行为级
  替身，内部用 SystemVerilog 队列建延迟线，**不可综合**；放在 `rtl/` 会让
  「本包 RTL 集合可综合」这一前提不成立。其端口名沿用 IP 契约（`aclk`/`aresetn`/
  `event_*`）以便被真实 IP 原地替换，按「标准总线保持协议原名」豁免。

### 接口/延迟契约变化（使用方必读）

- `m_axis_tdata` 由 16 位变 **32 位**
- `cfg_*` 三端口更名 `i_cfg_*`（注意：它们在模块内从未被使用，见 README F1）
- `mapper` 输出相对输入由 2 拍变 **3 拍**；`pilot_insert`/`cp_insert` 各 **+1~2 拍**

### 验证

- `mapper` 模块级性质 TB：900 拍（含随机反压）不丢不重、符号值逐笔正确、
  输出无 X、`tvalid` 未撤回。
- 全包 `vlog -sv` 编译干净（含 TB）。
- `tb_tx_top` 同步更新端口名并补 `$fatal`（原实现失败也退出 0）。
  **注意**：该 TB 与 `expected_tx.bin` 的比对在语义上仍不成立（驱动的是硬编码
  比特而非 golden 频域向量），见 README。
- gate-runner：`G-A-00/G-A-01/G-A-02/G-A-04/G-C-03/RL-OUT` 全绿。
