# CHANGELOG — ofdm_tx_top

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

### 仍未解决

L1 未跑综合（无 Fmax/资源/时序报告）、L2 无 bit-true cosim（`fidelity` 仍 `pending`）、
L3 导频极性非 802.11a PRBS 扰码、L4 反压恢复 1 拍气泡、L5 TB 场景覆盖不足。详见 README。

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
