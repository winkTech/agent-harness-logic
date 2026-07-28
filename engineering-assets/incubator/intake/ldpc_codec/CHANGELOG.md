# CHANGELOG — ldpc_codec

## 2026-07-28 — 编码器 hdl-coding 规范整改

本轮**只动 `ldpc_encoder_top`**。译码器侧（`ldpc_decoder_top` / `ldpc_controller` /
`h_matrix_addr` / `llr_buffer` / `msg_buffer` / `cn_update` / `early_term` /
`ldpc_stream_io`）在 2026-07-26 的重写中已完成红线整改并 bit-true 验证，
本轮未触碰，并已复跑回归确认未受波及。

### 变更（`ldpc_encoder_top`）

- **消除 `initial`（G-C-03 真实 fail）**：原文件两个 `initial`，其中用
  `if (p_rom[...] != 5'd31)` 扫描构建 `sys_col/sys_shf/sys_cnt` 的那个，条件依赖
  reg 数组内容，Vivado 判为非常量条件并报 `[Synth 8-6896]` **丢弃整个 initial 块**
  —— 仿真里三张表有值，综合后无驱动源（`[Synth 8-3848]`），上板行为与仿真不一致。
  这与 `h_matrix_addr.v` 里已修过的是同一个坑。现全部改为编译期 `localparam`
  扁平常量（`SYS_COL_FLAT` / `SYS_SHF_FLAT` / `SYS_CNT_FLAT` / `P_P0_12`），
  用变量基址位选 `[idx*W +: W]` 取值。
- **修复挂死**：`s_axis_info_tready` 原先在 `S_IDLE` 就为高，进 `S_LOAD` 之前那一拍
  已完成 AXI 握手把第一个信息位收走，而 `bit_cnt` 与 `info` 只在 `S_LOAD` 更新
  —— **第一位既不计数也不存储**。324 拍激励下 `bit_cnt` 最多到 322，
  `bit_cnt == K-1` 永不成立，状态机出不了 `S_LOAD`。现改为 ready 只在 `S_LOAD` 有效。
- 红线 2：`s_axis_info_tready` 由组合直出改 `ro_tready` 寄存输出。
- 红线 4/5：次态 case 补 `default` 分支。
- 命名：localparam 加 `P_` 前缀，内部寄存器加 `r_`/`w_` 前缀。

### P 矩阵常量表的生成方式

`SYS_*_FLAT` 三张表由 P 矩阵（802.11n R=1/2 Z=27）按**原 initial 里的扫描算法**
在编译前展开而来，与原实现逐条等价（生成脚本内置行重自检：最大行重 6 ≤ MAX_WT 8）。
P 矩阵原始数据（88 条非 -1 项）保留在 `models/comm/ldpc/` 的 golden 侧与本包
`h_matrix_addr.v` 中；**P 矩阵变更后必须重新展开这三张表**，否则编码器与
H 矩阵不一致。

### TB 修正（`tb_ldpc_encoder_top`）

- 收集循环原在 `@(posedge clk)` 处直接读 `m_tdata`，取到的是该边沿**之前**的旧值，
  且只看 tvalid 不看 tready，不是按握手采样。现严格按 `(tvalid && tready)` 成交采样。
  （注意：AXI-S 语义下正确的采样点就是边沿之前的总线值，不能 `#1` 越过边沿再读
  —— 那会取到 DUT 本边沿刚更新的下一拍数据。）
- 驱动侧改为在边沿判定成交、`#1` 越过边沿再换数据。
- `$finish(n_fail ? 1 : 0)` → `$fatal`。`$finish(N)` 的 N 是**诊断详略等级**不是
  进程退出码，原写法让失败与超时都以 0 退出，上游读起来全是通过。

### 验证

- **编码器**：`tb_ldpc_encoder_top` **5/5 通过**（全零码 + 4 组随机的系统码性质）。
  整改前为 1/5 —— 4 组随机用例全部挂死超时。
- **译码器 bit-true 回归（确认未受波及）**：`tb_ldpc_decoder_top` +
  `models/comm/ldpc/vectors/` 10 组向量，**每组 0/324 bit 失配，`synd_fail=0`**；
  `[G-C-04]` 稳定性 26 拍 0 抖动。
- gate-runner：`G-A-00/G-A-01/G-A-02/G-A-04/G-C-03/RL-OUT/G-B-03/G-C-01/G-C-02/
  G-C-04/G-C-05/G-GATE-01` 全绿，仅剩 `G-SIGN-01`（用户签字）与文档门。

## 2026-07-26 — 译码器控制架构重写

见 `ARCHITECTURE-GAP.md`。10 向量 3240 bit 0 失配，达 QUALIFICATION。
