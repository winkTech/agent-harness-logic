# CHANGELOG — channel_est_top

## [1.0.2] — 2026-08-02 声明证据复现入口（G-GATE-02）

manifest 新增 `reproduce` 字段，把"证据怎么重做"从 README 里的散文变成**机器可校验
的契约**。新门 `G-GATE-02` 校验该命令引用的脚本在仓库中真实存在。

动因：`G-GATE-01` 只查证据文件在不在，普查发现 16 个 certified 里 14 个的证据当时
无法被任何人重新生成，**却全都通过了 G-GATE-01**。

RTL、约束、TB、证据零改动；升 patch 版仅因 manifest 内容变化会使快照的
`manifest_sha256` 失配，按库内既定做法升版重取。

## [1.0.1] — 2026-08-02 补 xsim 复现通路（RTL 零改动）

本机 ModelSim 回环 RPC 自 2026-08-01 起故障，`.do` 那条路跑不通，本资产的
certified 证据无法复现。现补 `run_xsim.sh`，两条通路共用同一组 TB 与判据。

**交叉验证**：`alignment-report.json`（2048 点 0 失配）与 `reset-sim.json`
与 ModelSim 时代的记录**逐字节相同**；4 份 `stability/*.json` 内容一致，
只有 `tool` 字段不同——那正是应该不同的地方。

途中修掉三处 TB 缺陷：

1. **xsim 下 4 份 stability 证据的 `reason` 全是乱码。** 根因是
   `$fdisplay` 输出**作为参数传入**的多字节 string 会被打乱，换 `%0s` 也不管用
   （与宽度无关）。改为把文本直写进格式串——`crc32` 的 TB 早有同样的注释与做法，
   本 TB 当时没跟上。数字侧一直是对的，坏的只是人读的那部分。
2. **`tool` 字段写死 `"ModelSim 10.6c"`**，迁到 xsim 后会让证据声称自己出自一个
   并没有跑过它的仿真器。改为由运行脚本经 `sim-tool.txt` 注入。
3. **cosim TB 把 RTL 输出写进了 golden 的权威向量目录**
   （`{VEC_DIR, "rtl_chEst_frame_out.hex"}`）。RTL 产物混在期望值旁边迟早会被
   当成期望值用；实测它也确实以未提交状态在 `models/comm/channel_est/vectors/`
   躺了很久。改写到证据目录，并清掉了那份残留。

另：`EVID_DIR`/`VEC_DIR` 取不到时不再让证据静默不写，改为回落到运行目录相对
（同 `axis_skid_buffer` 1.0.1）；包内 `var_build/` 与 `transcript` 已清理，
根源是 `.do` 里 `set BUILD [file join $ROOT var_build]` 写死在包内构建。

版本 1.0.0 → 1.0.1（TB 属登记源）；RTL、约束与全部功能结论零改动。

## [1.0.0] — 2026-08-01 certified 认证

内容与 0.2.1 一致，无代码改动；本条为认证记账：

- G-SIGN-01：owner lihan 具名签署（manifest.signoff，含证据复核清单与
  7 条已接受限制）。
- gate-runner 20/20 全绿，达到 **CERTIFIED**；证据快照
  `evidence/channel_est_top/1.0.0/SNAPSHOT.json`（哈希锁定）。
- registry ITG-0001 repin 1.0.0，maturity_status → certified。
- 全流程：ADR-002 裁决 → golden 7/7 → RTL 架构重排 → bit-true cosim
  2048 点 0 失配 → qualification 证据链 → 签署，全链实跑取证。

## [0.2.1] — 2026-08-01 qualification 推进：G-A-04 拆分 + certified 证据链

行为零变化的结构拆分与证据补齐（cosim 拆分后复跑仍 **2048 样点 0 失配**）：

- **G-A-04**：`cpe_tracker.sv` 372 行 > 300 → 输出级拆出 `cpe_rotate_out.sv`
  （(c,s) 交接改寄存回执握手，`ro_rd_ce` 结构性防重取；全模块 ≤300 行）。
- **TB 证据链（G-C-04/05）**：`+EVID_DIR` 落盘——`reset-sim.json`
  （帧中再复位保持 3 拍，26 个复位控制寄存器逐一比对；数据通路寄存器按
  §1.1 设计性不复位，不在比对面）+ `stability/{boundary,stress,regression,
  backpressure}.json`；新增 T7 压力场景（背靠背 2×LTS+8 数据符号 + 随机
  反压叠加，512 点全比对）。
- **G-C-01/02**：manifest 补 `device.part` 与资源预算
  （lut 900 / ff 750 / bram 2 / dsp 20，基于 0.2.0 实测 749/610/1/8 留裕量）；
  pg-synth 产物链（timing-summary/utilization/synth.log/envelope-check）。
- fidelity=bit_true（0.2.0 cosim 实证）；声明级 intake → **qualification**。

## [0.2.0] — 2026-07-31 ADR-002 架构重排：LTS-LS + 导频 CPE 跟踪

估计基础按 ADR-002 从「4 导频 LS + 线性插值」整体重排为「长训练符号全用载波
LS + 导频公共相位跟踪」（插值路径违反采样定理，spec §1.4 已降为备选）。

### 架构变更

- **删除** `ls_estimator.sv`（旧导频提取）与 `channel_interpolator.sv`（线性插值）。
- **新增** `lts_estimator.sv`（2×LTS 平均全用载波 LS → 64×36 H_LTS RAM +
  导频位旁路捕获）、`cpe_tracker.sv`（导频积累加 → CPE → e^{jCPE} 逐点校正输出）、
  `cordic_cv.sv`（向量/旋转双模 CORDIC，14 迭代，无 DSP）。
- **接口变更**：新增 `i_frame_start` 侧带脉冲（标记 LTS1，领先 ≥1 拍；
  风格同 `sync_top.o_fft_start`）；复位后 UNSYNC 静默丢弃样点直至帧起始。
- 0.1.0 遗留缺陷（极性表/斜率定点/累加溢出/`interp_busy` 自指/无双缓冲/
  `o_pilot_valid` 未用）随旧数据通路整体替换而消灭。
- 定点语义（LTS 平均 +1 舍入 / S 累加 >>>14 / CORDIC 常数表 / round+饱和）
  在 RTL 头注释中固定，要求与 `generate_vectors.m` 位真镜像逐字同步。

### 验证（全部实跑）

- 定向自检 TB 重写（S1-S5 六场景，解析期望 ±12 LSB，$fatal 失败路径）：
  **ALL TESTS PASSED**，末拍→输出完成实测 **111 拍**（门限 400）。
- Vivado 2023.1.1 OOC @ xc7k325t：rtlcheck 0 违例；synth WNS **+4.673 ns**
  @10 ns；LUT 749 / FF 610 / BRAM 1 / **DSP 8**（预算 <20）；CDC critical 0。
- cosim TB 改造为帧级 0 容差逐字比对（fail-closed），待位真向量后运行（G-B-03）。

## [0.1.0] — 2026-07-28 hdl-coding 规范整改

按 `docs/rules/01-hdl.md` 五条红线整改全部 RTL，并修复两个让整条信道估计链
从未产出过结果的功能缺陷（不修就无法做任何验证）。

### 编码规范变更

- 复位：全部 `negedge rst_n` 异步低有效 → 同步高有效 `i_rst`；
  `channel_interpolator` 的 delta/prod 两级此前**完全无复位**，已补齐。
- 命名：`clk/rst_n/start/pilot_*` → `i_clk/i_rst/i_start/i_pilot_*`；
  非 AXI 输出补 `o_`；内部改 `ri_/ro_/r_/w_`；FSM 状态改 `P_`。
- 红线 1：`ls_estimator` 新增 `ri_` 输入寄存级。
- 红线 2：`s_axis_tready` / `o_pilot_valid` / `o_symbol_done` / `m_axis_*`
  全部改 `ro_` 寄存驱动；插值器输出级与累加器共用统一使能，反压时整体冻结。
- 红线 4/5：三个 FSM 均改三段式并补 `default`。
- **§5 位宽修正**：`sub_idx` 原声明 `[N_FFT-1:0]`=64 位、`pilot_cnt` 原声明
  `[N_PILOT-1:0]`=4 位 —— 把「计数上限」误当「位宽」写。改为 `$clog2` 推导的
  6 位 / 3 位，并加数组索引范围保护。
- **封装**：删除 `channel_est_top.sv` 对 `u_interpolator.m_axis_tvalid` 的跨层次
  引用，改用顶层端口信号。

### 修复的两个致命功能缺陷

1. **子载波计数差一** —— `ls_estimator` 原先只在 `state == CAPTURE && 握手` 时
   计数，而 `IDLE→CAPTURE` 恰由第一个握手拍触发，**第一拍不计数**。64 拍激励下
   `sub_idx` 最多到 62，`sub_idx == N_FFT-1` 永不成立，状态机出不了 CAPTURE，
   `o_symbol_done` 从未置位过。
2. **导频计数不按符号清零** —— `pilot_cnt` 原先只有复位才清零，第一个符号抓满
   4 个导频后停在 4，之后所有符号的导频写入全部越界被丢弃。

这两项此前一直没暴露，是因为原 TB 用裸 `#5000` 延时后直接读 `m_axis_tdata`
（读到的是残留值），从未按握手捕获整个符号再比对。

### TB 修正

- 激励量化：原用 `$shortrealtobits(v*16384.0)` —— 该函数返回 IEEE-754 单精度
  **位模式**而非定点整数，送进 DUT 的是无意义比特，而 `check_h` 却按 Q2.14
  整数解释。改为 `$rtoi` 取整 + 饱和。
- 输出采样：改为按 `m_axis_tvalid` 握手捕获整符号后再逐点比对
  （原 `check_h` 的 `idx` 参数从未真正参与索引）。
- 补 `$fatal`（原实现失败也退出 0）。

### 验证

- `tb_channel_est`：Test 1 平坦信道 H=1、Test 2 复常数信道 0.5+0.5j，
  两个符号各 **64/64 子载波全部捕获**，抽查 5 个子载波（含 DC）全部在 ±3 LSB 内，
  `ALL TESTS PASSED`。**这是本包第一次跑出端到端有效结果。**
- gate-runner：`G-A-00/G-A-01/G-A-02/G-A-04/G-C-03/RL-OUT` 全绿。
