# CHANGELOG — ofdm_tx_top

## 2026-07-28 — hdl-coding 规范整改

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
