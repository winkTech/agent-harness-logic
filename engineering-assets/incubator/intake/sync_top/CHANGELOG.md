# CHANGELOG — sync_top

## 2026-07-28 — hdl-coding 规范整改

按 `docs/rules/01-hdl.md` 五条红线整改全部 RTL。**只动编码规范层面**；
算法/数值层面的遗留缺陷未改，逐条列在 README「遗留缺陷」表。

### 变更

- 复位：`negedge rst_n` 异步低有效 → 同步高有效 `i_rst`；此前多个
  `always_ff` 完全无复位，已全部补齐。
- 命名：`clk/rst_n` → `i_clk/i_rst`；非 AXI 端口补 `i_`/`o_` 前缀；
  内部信号改 `ri_/ro_/r_/w_`；FSM 状态改 `P_` 前缀。
- 红线 1：`packet_detect` / `fine_timing` / `cordic_core` / `sync_top`
  新增 `ri_` 输入寄存级。
- 红线 2：`m_axis`、`o_sync_locked`、`o_metric_*` 改由 `ro_` 寄存器驱动。
- 红线 4：`sync_top` FSM 由二段式改三段式并补 `default`。
- `fine_timing`：删除一个只有注释的空 `always_ff` 死块。

### 接口/延迟契约变化（使用方必读）

- `sync_top` 的 `m_axis` 相对 `s_axis` 由 0 拍变 **2 拍**
- `packet_detect` 输入到 `o_metric_valid` 由 5 拍变 **6 拍**
- `fine_timing` 全链整体后移 1 拍（数值不变）
- `cordic_core` 由 `STAGES+1` 拍变 **`STAGES+2`** 拍

### 整改中发现的致命缺陷（已消除）

**`packet_detect` 此前处于永久 X 锁死状态，从未检出过任何包。**
`p_i`/`p_q` 无复位，上电为 X；累加器自反馈 `acc_i <= acc_i + p_i - pd_i[L_CORR]`，
第一个 `tvalid` 拍就把 X 吸进 `acc_i` 且永远出不去 → `c2` 恒 X → 判定恒假。
已用对拍 TB 取证（旧版 `acc_i=xxxxxxxx`，整改版同时刻为确定值）。

### 验证

- `tb_sync_top`：包检测在 CFO=0.3 / CFO=-1.2 两种条件下均置位；
  `m_axis == s_axis` 延迟 2 拍逐位一致（768 拍）；`o_fft_start` 检查标记为
  xfail（对应遗留缺陷 F3）。
- 模块级性质 TB：整改版复位后全程无 X、对周期输入 100% 响应、复位可重入。
- gate-runner：`G-A-00/G-A-01/G-A-02/G-A-04/G-C-03/RL-OUT` 全绿。
