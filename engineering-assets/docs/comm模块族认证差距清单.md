# comm 模块族认证差距清单

样板基线: `rrc_polyphase_fir` 已达 qualification (bit-true 2048 样点 0 失配)。其修复路径 (下文简称 rrc 路径) 为: **命名 i_clk/i_rst → 同步高有效复位 → 寄存输出 → 去 initial → 系数对齐 golden → cosim**。以下每个模块的修复清单均按此顺序映射。

数据来源标注约定: 【实测】= 门禁 runner 输出 (G-* 门状态、编译结果、sha256、向量抽查); 【观察】= agent 静态阅读 RTL/TB 得出、未经仿真验证的结论。

---

## 1. 总览表

| 模块 | asset_uid | 达到级别 | 阻塞门数 | 红线违规 | 修复工作量 (到 qualification) | golden 向量健康度 |
|:---|:---|:---|:---|:---|:---|:---|
| comm/ofdm | ofdm_tx_top | reference (卡 intake 级 G-A-02) | 6 (2 fail + 4 blocked) | 10 条: 红线1(命名面)/2/3 + 阻塞混用 | med (改名 6 文件 + 3 模块复位重构); 真 cosim 另一档 | **健康**【实测】— 4 族中唯一可用, 但仅 1 符号 vs TB 期望 10 符号 |
| comm/ldpc | ldpc_codec | **intake** (4 族最高) | 6 (2 fail + 4 blocked) | 10 条: 红线1/2/4 + 5 处 initial + 命名 | med (initial→$readmemh + 拆 always); 含功能修复则偏 high | .mat 健康【实测抽查】, 但 TB 引用的 .hex 向量全缺 (从未导出) |
| comm/synch | sync_top | reference | 7 (3 fail + 4 blocked) | 6 条: 红线1/2/3/4 + 命名 + 2 处编译错误 | med, 但 certified 有结构性算法缺口 | **完全缺失** — 向量从未生成, 需 MATLAB 首次生成 |
| comm/channel_est | channel_est_top | reference | 7 (3 fail + 4 blocked) | 5 条: 红线1/2/3/4 + 命名 | med (机械但输出寄存改流水延迟, 需回归) | **完全缺失** — 从未导出; 自检 TB 激励本身有 bug |

注: 阻塞门数 = fail (当前级别/qualification 实际拦截) + blocked (certified 级前置未接线)。4 个包的 G-B-03/G-C-01/G-C-02/G-SIGN-01 四门全部 blocked, 属共性 (见第 3 节)。

---

## 2. 各模块明细

### 2.1 ofdm_tx_top (comm/ofdm)

**阻塞门**【实测】
- G-A-02 FAIL (intake, 唯一 intake 阻塞): clk→i_clk, rst_n→i_rst, cfg_fft_len/cfg_cp_len/cfg_mod_type 缺 i_ 前缀, 共 5 项。
- G-A-01 FAIL (qualification): active_low + 异步无同步释放 + RTL 存在 `negedge rst_n`。
- G-B-03 / G-C-01 / G-C-02 / G-SIGN-01 blocked (certified: 无 cosim 证据 / STA 未接线 / synth util 未接线 / 无 signoff)。
- 已过项: G-A-00 (vlog 0E/0W)、CS-1/CS-2 (sha256 全匹配)、G-B-02 (golden 解析 model_comm_ofdm)、G-C-03 (无 initial)、G-A-04。

**红线违规 (file:line)**
- 红线3 复位【实测 + 观察定位】: `ofdm_tx_top.sv:18` rst_n 异步低有效贯穿全链; `pilot_insert.sv:76/112/158`、`cp_insert.sv:65/91/147` 均为 `always @(posedge clk or negedge rst_n)`; `mod_mapper.sv:28` 用 `!rst_n` 翻转喂 mapper (仅 mapper.sv 内部同步高有效)。
- 命名【实测 (G-A-02) + 观察 (子模块)】: `ofdm_tx_top.sv:17-18,33-35`; `pilot_insert.sv:13-14`; `cp_insert.sv:15-16`; `mod_mapper.sv:11-12`; `mapper.sv:50-57` 输入寄存用 r_data_d1 而非 ri_ (红线1 命名面)。AXI 与 xfft aclk/aresetn 豁免。
- 红线2 组合直出【观察 — RL-OUT 门只查顶层故机械 pass】: `mapper.sv:64-65` / `pilot_insert.sv:184` / `cp_insert.sv:176` s_axis_tready 组合直出; `cp_insert.sv:129-141` m_axis_tdata 组合 RAM 读直出, 且 tvalid 依赖 tready (兼违 AXI-Stream 协议)。
- 混用【观察】: `mapper.sv:94` 时序块内阻塞赋值。

**到 qualification 修复清单 (按 rrc 路径)**
1. 命名: 6 文件机械改名 (上列全部点位) + TB 例化同步 → 清 G-A-02。
2. 复位同步化: pilot_insert / cp_insert / mod_mapper 三模块去 `negedge rst_n`, 统一同步高有效 i_rst, 消除 mod_mapper.sv:28 极性翻转 → 清 G-A-01。
3. 寄存输出: 3 处子模块 tready 改 ro_; cp_insert m_axis_tdata RAM 读出加一拍并解开 tvalid←tready 依赖。
4. 去 initial: 已达标, 无动作。
5. 附加: mapper.sv:94 阻塞改非阻塞。

**cosim 闭环前置 (certified 档, 另计工作量)**【观察, 均如实记录未修】: (1) `cp_insert.sv:43` wr_bank 无驱动→乒乓失效仿真恒 X; (2) DATA_WIDTH=16 与 32bit {Q,I} 打包语义冲突, 存在截断; (3) xfft_64 是延迟线透传占位, 非真实 IFFT → 不可能对齐 expected_tx; (4) TB 假绿: expected_len 恒 0, 比对 0 样点报 PASS; (5) VEC_DIR 路径不符; (6) 向量 1 符号 vs TB 期望 10; (7) 64QAM 桩恒 0; (8) Q2.14 注释实为 Q1.15 缩放 (已录 manifest)。

---

### 2.2 ldpc_codec (comm/ldpc)

**阻塞门**【实测】
- G-C-03 FAIL (qualification): 5 处综合源 initial — `h_matrix_addr.v:64/117/132` (ROM+LUT), `ldpc_encoder_top.v:49/84` (P 矩阵 ROM + 连接表)。
- G-A-04 FAIL (qualification): `ldpc_controller.v:115` 次态 always 51 行 > 50 上限。
- G-B-03 / G-C-01 / G-C-02 / G-SIGN-01 blocked。
- 已过项: G-A-00 (0E/0W)、CS-1/CS-2、G-B-02、G-A-01/G-A-02 (未见复位/命名门 fail — 4 族中唯一无复位红线违规的包)。

**红线违规 (file:line)**【观察 — RL-OUT 机械 pass 有水分: 该门只扫 always_comb, 本包用 always @(*)】
- 红线1: `ldpc_decoder_top.v:93` 加载计数直用未寄存 s_axis_llr_tvalid, 而寄存版 ri_llr_valid/ri_llr_data (79-91) 声明后从未使用; `ldpc_encoder_top.v:152,171,200-201` tvalid/tdata 未寄存直驱 FSM; `early_term.v:36-39`; `llr_buffer.v:18-33` / `msg_buffer.v:20-34` 读地址未寄存。
- 红线2: `ldpc_decoder_top.v:103`、`ldpc_encoder_top.v:275` tready 组合直出; 两 buffer o_rd_data 组合读直出。
- 红线4: `ldpc_encoder_top.v:151-157` case 无 default (有前置默认赋值, 无锁存)。
- initial (G-C-03 来源)【实测】: 上列 5 处。
- 命名: `ldpc_encoder_top.v:34-42,124-137` localparam 无 P_、内部信号无 r_ 前缀。

**到 qualification 修复清单 (按 rrc 路径)**
1. 命名: encoder_top P_/r_ 前缀补齐 (机械)。
2. 复位: 无动作 (已合规)。
3. 寄存输出: decoder_top.v:103 / encoder_top.v:275 tready 改 ro_; buffer 改同步读 (注意读时延 +1 拍传播到 controller/cn_update 时序, 需回归)。
4. **去 initial (qualification 关键门)**: 5 处 initial → `$readmemh` + 生成 hex 表 + 与原 initial 内容做等价性比对 — 完全对应 rrc 路径同名步骤。
5. G-A-04: 拆分 ldpc_controller.v:115 的 51 行次态 always (琐碎)。
6. 红线4: encoder case 补 default。

**cosim 闭环前置**【观察】: (1) LLR 加载路径疑似断裂 — ri_llr_data 寄存后从未写入 llr_buffer (写口仅迭代回写驱动); (2) `ldpc_decoder_top.v:170/201` 用未声明的 w_h_conn_count (声明名为 w_conn_count, 行 58) → 1-bit 隐式线网截断 4-bit 计数, vlog 默认不告警, **G-A-00 干净不能排除此缺陷**; (3) TB .hex 向量全缺, 需跑 gen_rtl_test_vectors.m 首次导出; (4) run_sim.do / compile.tcl 相对路径仍指旧布局 ../01_rtl/。含 (1)(2) 修复则 fix_effort 偏 high。

---

### 2.3 sync_top (comm/synch)

**阻塞门**【实测】
- **G-A-00 FAIL (intake, 4 族唯一编译不过)**: `fine_timing.sv:95` vlog-2730 类型转换 `corr_t'` 全库无定义; `fine_timing.sv:110` rst_n_sync 未声明, 且 `if(rst_n_sync)` 进复位分支, 极性疑似写反【极性判断为观察】。
- G-A-02 FAIL: clk/rst_n 无前缀; 输出 fft_start/sync_locked 缺 o_ 前缀。
- G-A-01 FAIL (qualification): active_low 异步无同步释放。
- G-B-03 / G-C-01 / G-C-02 / G-SIGN-01 blocked; 其中 G-B-03 不仅无证据, **向量从未生成, 无法立即补**。
- 已过项: CS-1/CS-2、RL-OUT (机械判)、G-C-03、G-A-04、G-DOC-01、G-B-01/G-B-02。

**红线违规 (file:line)**【观察, RL-OUT 正则只查 always_comb 驱动链故机械 pass, 人工判违规】
- 红线1: `sync_top.sv:86-87` s_axis tvalid/tdata 直通 m_axis; `packet_detect.sv:117` metric_valid 直通; 全库无任何 ri_ 寄存。
- 红线2: `sync_top.sv:86-87` m_axis 组合直出、`:106` sync_locked 组合直出; `packet_detect.sv:116-118`; `cordic_core.sv:93-96` 寄存器别名 assign 未走 ro_。
- 红线3: `sync_top.sv:64,101`; `packet_detect.sv:29,59,76,101`; `fine_timing.sv:49,98`; `cordic_core.sv:37` 均 negedge rst_n; 另无复位 always_ff: `packet_detect.sv:46,95,110`; `fine_timing.sv:68,81,109`; `cordic_core.sv:59`。
- 红线4: `sync_top.sv:92-104` 二段式 FSM, case 无 default。
- 红线5: 未发现 (合规)。
- 编译级死代码: `fine_timing.sv:81-85` 空 always_ff。

**到 qualification 修复清单 (按 rrc 路径, 前置第 0 步)**
0. **先修编译** (intake 硬阻塞): sync_pkg 中定义 corr_t; fine_timing.sv:110 声明 rst_n_sync (做成真正的复位同步器) 并核对极性; 删 81-85 空块。
1. 命名: 5 文件 + TB 改 i_clk/i_rst/o_fft_start/o_sync_locked 等。
2. 复位: 全部 negedge rst_n 改同步高有效 (上列 8 处) + 7 处无复位 always_ff 补复位或逐一论证 → 触及每个时序块, 需整体回归。
3. 寄存输出: m_axis 直通占位改寄存; sync_locked、packet_detect 三输出、cordic 别名改 ro_。
4. FSM: sync_top.sv:92-104 二段式改三段式 + default。
5. 向量对齐: MATLAB 跑 run_synch_sim.m + generate_vectors.m 首次生成 expected_sync_out.bin + vector_config.txt。
6. cosim: **存在结构性算法缺口** — cordic_core 已实现但顶层未例化 (孤立), CFO 估计/校正数据通路整体缺失, m_axis 为直通占位 → 与 golden (含 coarse/fine CFO) 对标前需补算法通路, 这是功能开发, 不是打包修复【观察】。

---

### 2.4 channel_est_top (comm/channel_est)

**阻塞门**【实测】
- G-A-02 FAIL (intake): clk→i_clk, rst_n→i_rst。
- G-A-01 FAIL (qualification): active_low 异步无同步释放 + negedge rst_n。
- **RL-OUT FAIL (qualification, 4 族唯一被该门实测命中)**: m_axis_tdata 由 always_comb 结果 assign 直出。
- G-B-03 / G-C-01 / G-C-02 / G-SIGN-01 blocked; 向量从未导出, cosim TB 当前根本不可运行。
- 已过项: vlog 0E/0W、G-C-03 (无 initial)。

**红线违规 (file:line)**
- 红线1【观察】: `ls_estimator.sv:64-70` (tdata/tvalid 直进组合 pilot_match)、`:81-85` (未寄存直接采样); `channel_est_top.sv:46-48` 输入直通子模块。
- 红线2【RL-OUT 实测命中 1 条 + 观察 4 条】: `channel_interpolator.sv:125` m_axis_tdata (门禁命中)、`:124` m_axis_tvalid; `ls_estimator.sv:123/124/125` tready/pilot_valid/symbol_done。
- 红线3【实测 + 观察定位】: `channel_est_top.sv:70`; `ls_estimator.sv:47/72/113`; `channel_interpolator.sv:38/58/76/101/119` negedge rst_n; `channel_interpolator.sv:44,53` 两个 always_ff 完全无复位。
- 红线4【观察】: `ls_estimator.sv:96-111`、`channel_est_top.sv:61-68`、`channel_interpolator.sv:109-117` case 无 default。
- 红线5: 未发现 (合规)。
- 其他【观察】: `channel_est_top.sv:93` 跨层级引用 u_interpolator.m_axis_tvalid (综合不友好)。

**到 qualification 修复清单 (按 rrc 路径)**
1. 命名: 3 文件 clk/rst_n 改名 (机械)。
2. 复位: 上列全部点位改同步高有效; interpolator.sv:44/53 补复位。
3. 寄存输出: RL-OUT 命中的 m_axis_tdata/tvalid + ls_estimator 3 输出改 ro_ 寄存 — **注意标称 131clk@100MHz 延迟契约会 +1~2 拍, spec 与 TB 检查点需同步更新**。
4. 去 initial: 已达标, 无动作。
5. FSM: 3 处 case 补 default; 顺带消除 :93 跨层级引用 (改端口引出)。
6. 验证闭环前置【观察】: (a) 自检 TB 激励错误 — send_sym 用 $shortrealtobits 打包 IEEE-754 浮点而非 Q2.14, check_h 多点检查不推进时钟 (全采同一拍), 必须先修否则任何"通过"无意义; (b) 跑 generate_vectors.m 首次导出 rx_chEst.bin/expected_chEst.bin/vector_config.txt; (c) uvm_tb 引用的 ../../../../../docs/templates/uvm/ 在仓库中不存在, 按原样不可编译; (d) run_rtl_cosim.m 未随 golden_model/* 迁移, 需补迁。

---

## 3. 全库结论

### 3.1 推进顺序建议 (按修复性价比排序)

1. **ldpc_codec** — 唯一已达 intake; 到 qualification 只剩 2 个 fail 门且全是机械活 (5 处 initial→$readmemh + 拆 1 个 51 行 always), 是全库唯一**不需要复位体系改造**的包。先做它, 最快产出第二个 qualification 资产。附加条件: 若目标含可信 cosim, 必须先修 LLR 加载断裂 + w_h_conn_count 隐式线网 (工作量升 high), 建议 qualification 与 cosim 分两个里程碑。
2. **ofdm_tx_top** — intake 只差改名一门; **4 族中唯一 golden 向量健康的包**, 向量侧到 cosim 的距离最短。qualification = 6 文件改名 + 3 模块复位同步化 (med)。但 certified 被 xfft_64 占位卡死 (透传非真实 IFFT, 物理上不可能 bit-true), 需明确立项"接入真实 FFT 核"才有 certified 意义。
3. **channel_est_top** — 编译干净, 修复项全部机械 (命名 + 复位 + 输出寄存), 但输出寄存改变 131clk 延迟契约需要回归, 且验证闭环要先修 TB 激励 bug + 首次生成向量, 闭环成本高于前两者。
4. **sync_top** — 性价比最低: 编译都不过 (全库唯一 G-A-00 FAIL), 复位改造触及每个时序块, 且 CFO 数据通路整体缺失 + cordic_core 孤立 → certified 存在结构性算法缺口, 属功能开发而非认证修复。建议本轮只修到 qualification (第 0-4 步), CFO 通路单独立项。

### 3.2 共性问题 (建议库级统一处理, 勿逐包重复决策)

- **复位风格债 (3/4)**: ofdm/synch/channel_est 全部为异步低有效 negedge rst_n 无同步释放, 与 rrc 修复前状态完全同构; ldpc 是唯一例外。建议复用 rrc 的同步高有效复位模板做一次批量改造 + 批量回归, 不要逐模块发明写法。另 synch/channel_est 共 9 处无复位 always_ff, 需逐个论证或补复位。【实测 (G-A-01) + 观察 (点位)】
- **命名债 (4/4)**: 全库 clk/rst_n 无 i_ 前缀, AXI 豁免口径一致。建议写一个批量端口改名脚本 (端口声明 + 例化点 + TB 三处同步), 一次清掉 4 个包的 G-A-02。【实测】
- **红线1/2 普遍违规 (4/4)**: 输入不经 ri_、tready/tvalid/tdata 组合直出遍布全库。其中 tready 组合直出是 AXI-Stream 握手惯用法, 寄存化会改变握手时序 — 建议先做一次**库级裁决** (寄存 tready 的统一模式, 如 skid buffer), 再统一执行, 避免 4 个包各改各的。【观察】
- **门禁工具自身缺口 (本轮实测暴露, 应修 gate-runner)**: (1) RL-OUT 正则只扫 always_comb 驱动链且只查顶层输出 → ofdm/ldpc/synch 三包机械 pass 但人工复查均属实违规, channel_est 只是碰巧用了 always_comb 才被抓到; 需增强为覆盖 assign 直出 + always @(*) + 子模块。(2) G-A-00 编译干净不能拦截隐式线网 (ldpc 1-bit 截断案例), 建议门禁强制 `` `default_nettype none `` 或加 lint 步。
- **验证资产/TB 债 (4/4)**: 3 包向量缺失 (见 3.3); UVM 实体依赖 knowledge/docs/templates/uvm/ 共享模板, 不随包复制 → synch/channel_est 包内断链、ofdm 未复制, 建议把共享 UVM 模板做成独立受管资产并进打包清单。ofdm TB 假绿 (expected_len=0 比对 0 样点报 PASS) 与 channel_est TB 激励类型错误说明: **现有自检 TB 的 PASS 一律不可作为证据**, 复用前须过验证质量门禁。【观察】

### 3.3 golden 向量损坏情况汇总

- **无 rrc 式损坏**: 4 个包均未发现 rrc 那种整文件常量轨损坏。实测抽查: ofdm expected_tx.bin 80 行 64 唯一值、tx_i/tx_q 63-64 唯一值健康 (freq_i/freq_q 唯一值 5/3 为 QPSK 星座正常离散取值, 非损坏); ldpc .mat 为合法 MATLAB 5.0 头、字节分布正常。【实测】
- **缺失才是本轮主要问题, 分三类**: (1) ldpc — 模型 .mat 健在但 TB 引用的 tb_llr_input_*.hex / tb_expected_output_*.hex 全树不存在 (gen_rtl_test_vectors.m 从未导出); (2) synch — expected_sync_out.bin + vector_config.txt 从未生成; (3) channel_est — rx_chEst.bin / expected_chEst.bin 从未导出。三者均需 MATLAB 首次生成, 已分别记入各 model manifest provenance。【实测 (文件不存在) + 观察 (从未生成的归因)】
- **覆盖不足**: ofdm 向量虽健康但仅 1 符号, TB 期望 10 符号; 且缩放口径 Q1.15 与注释 Q2.14 不符, cosim 前需统一。【观察】

---

## 4. 结论来源分类总表

| 结论类别 | 来源 |
|:---|:---|
| 各门 fail/blocked/pass 状态、G-A-00 编译结果 (含 sync_top 2 个 Error 的报错行)、G-A-02 命名项计数、CS-1/CS-2 sha256、G-B-02 golden 解析 | **门禁实测** (证据留档 engineering-assets/var/gates/pg/<asset_uid>/) |
| ofdm/ldpc 向量文件的唯一值分布与 .mat 头抽查; ldpc/synch/channel_est 向量文件不存在 | **门禁实测/文件系统实测** |
| 子模块层面红线1/2 违规、RL-OUT "机械 pass 有水分" 的判定、FSM 无 default、阻塞/非阻塞混用 | **agent 观察** (静态阅读, RL-OUT 工具覆盖不到) |
| 功能疑点: ofdm wr_bank 无驱动/位宽截断/xfft 占位/TB 假绿; ldpc LLR 路径断裂/隐式线网; synch CFO 通路缺失/极性写反; channel_est TB 激励错误/跨层级引用 | **agent 观察** (未经仿真复现, cosim 修复前无法实测确认) |
| fix_effort 评级与推进顺序 | **agent 判断** (基于上述实测 + 观察的综合) |