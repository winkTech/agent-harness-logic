# ldpc_codec — 802.11n QC-LDPC 编译码器 (intake 评估性打包)

> 评估性打包: 源 RTL 原样迁入, **未做任何修改**。红线违规与结构缺陷如实记录于下, 不在本包内修复。

## 概要

| 项 | 值 |
|:---|:---|
| 码型 | 802.11n QC-LDPC, R=1/2, N=648, K=324, Z=27 |
| 译码算法 | 归一化 Min-Sum (alpha=0.75=12/16, 移位加法), 分层行串行, max 20 迭代, syndrome 早停 |
| 编码算法 | 双对角回代 (Dual-Diagonal), 1 bit/cycle AXI-Stream |
| 定点格式 | LLR Q(10,4) |
| 顶层 | `ldpc_decoder_top` (主资产, manifest ports 依此登记); `ldpc_encoder_top` 为同包第二顶层 |
| Golden | `model_comm_ldpc` (engineering-assets/models/comm/ldpc/) |
| 源 | engineering-assets/knowledge/primary/domains/comm/ldpc/ |

## 包结构

```
rtl/          9 个综合源 (2 顶层 + 6 子模块 + ldpc_defines.vh)
tb/           3 个普通 TB (decoder/encoder/system 全链路) + run_sim.do (路径为源库旧布局, 未改)
tb/uvm/       UVM 环境 11 个 .sv + compile.tcl
constraints/  ldpc_decoder.xdc
```

模块层次 (decoder): `ldpc_decoder_top` → h_matrix_addr / llr_buffer / msg_buffer / cn_update / early_term / ldpc_controller。
`ldpc_encoder_top` 无子模块。`tb_ldpc_system.v` 例化 encoder+decoder 做全链路。

## 红线类违规 — 整改记录

> 本节此前记录的多数条目已在**译码器重写**（见 `ARCHITECTURE-GAP.md`，2026-07-26）
> 与 **2026-07-28 编码器规范整改**中修复。下表为当前状态。

| 条目 | 当前状态 |
|:-----|:---------|
| 红线1 输入未寄存（译码器） | **已修**：`ldpc_stream_io` 承担输入寄存与握手 |
| 红线1 输入未寄存（编码器） | **未修**（见下方 D1） |
| 红线2 组合直出 `llr_buffer`/`msg_buffer` `o_rd_data` | **已修**：改同步读 + `ro_rd_data` |
| 红线2 组合直出 `s_axis_llr_tready`（译码器） | **已修**：由 `ldpc_stream_io` 驱动 |
| 红线2 组合直出 `s_axis_info_tready`（编码器） | **已修**：改 `ro_tready` 寄存输出 |
| 红线4/5 编码器次态 case 缺 default | **已修** |
| `initial` 用于综合源（`ldpc_encoder_top`） | **已修**：两个 `initial` 全部消除，见下 |
| `initial` 用于综合源（`h_matrix_addr`） | **保留**：纯常量阵列初始化，属 ROM 推断的标准写法；gate-runner G-C-03 对"仅初始化存储器阵列"的 `initial` 明确不判 fail，且该文件已由 Vivado 综合日志证实无 `[Synth 8-6896]` |
| 命名违规（编码器） | **已修**：localparam 加 `P_`，内部信号加 `r_`/`w_` |
| 隐式 1-bit 线网 `w_h_conn_count` | **已修**：已正确声明为 `[P_CONN_CNT_W-1:0]` |
| LLR 加载路径断裂 | **已修**：译码器重写后 10 向量 3240 bit 全 0 失配 |

### 2026-07-28 编码器整改：两个必须记录的发现

1. **`initial` 被综合器丢弃（G-C-03 真实 fail）** —— `ldpc_encoder_top` 原先用
   `if (p_rom[...] != 5'd31)` 在 `initial` 里扫描构建 `sys_col/sys_shf/sys_cnt`。
   条件依赖 reg 数组内容，Vivado 判为非常量并报 `[Synth 8-6896]` **丢弃整个
   `initial` 块** —— 仿真里三张表有值，综合后无驱动源。这与 `h_matrix_addr.v`
   里已修过的是同一个坑。现已把展开搬到编译前，落成 `rtl/ldpc_encoder_tables.vh`
   里的 `localparam` 常量（附 P 矩阵 provenance 供重新生成）。

2. **编码器此前处于挂死状态** —— `s_axis_info_tready` 在 `S_IDLE` 就为高，
   进 `S_LOAD` 之前那一拍已经完成 AXI 握手把第一个信息位收走，而 `bit_cnt`
   与 `info` 只在 `S_LOAD` 态更新，**第一位既不计数也不存储**。324 拍激励下
   `bit_cnt` 最多到 322，`bit_cnt == K-1` 永不成立，状态机出不了 `S_LOAD`。
   现改为 ready 只在 `S_LOAD` 有效。
   此前没被发现的原因：TB 的 `$finish(n_fail ? 1 : 0)` 用错了 —— `$finish(N)`
   的 N 是**诊断详略等级**不是退出码，超时也以 0 退出。

### 已知限制与验证边界（遗留项）

- **D1（红线1，编码器）**：`s_axis_info_tvalid/tdata` 仍被直接消费，未经 `ri_` 寄存。
  该模块的加载相位与状态机计数强耦合（`bit_cnt` 既当写地址又当状态出口判据），
  插入 `ri_` 级需同步移动写地址与出口判据，属控制通路重构；且编码器**尚无
  bit-true golden 对标**（TB 只验全零码与系统码性质），重构后无法证明数值不变。
  留待补齐编码器 golden 向量后再做。
- `tb/run_sim.do`、`tb/uvm/compile.tcl` 中的相对路径仍指向源库旧布局（`../01_rtl/`）。

## 验证证据（2026-07-28 复跑）

- **译码器 bit-true 回归**：`tb_ldpc_decoder_top` + `models/comm/ldpc/vectors/`
  10 组向量，**每组 0/324 bit 失配，`synd_fail=0`**；`[G-C-04]` 稳定性 26 拍 0 抖动。
  编码器整改**未波及**译码器。
- **编码器**：`tb_ldpc_encoder_top` **5/5 通过**（全零码 + 4 组随机的系统码性质），
  整改前为 1/5（随机用例全部挂死超时）。
- TB 采样时序同步修正：收集循环原在 `@(posedge clk)` 处加 `#1` 越过边沿采样
  会取到下一拍数据；AXI-S 语义要求取边沿**之前**的总线值。

## 门禁状态

见 `engineering-assets/var/gates/pg/ldpc_codec/gate-results.json` (由 `node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/intake/ldpc_codec` 生成)。
