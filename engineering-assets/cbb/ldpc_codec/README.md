<!-- asset-status: certified v1.0.4 -->

# ldpc_codec — 802.11n QC-LDPC 编译码器

> **certified 1.0.4**（RTL 与证据同 1.0.0，2026-07-31 签署，20 门全绿）。已知限制的权威清单在
> [`docs/limitations.md`](docs/limitations.md) —— 复用前必读。
>
> 本包最初是 intake 评估性打包（源 RTL 原样迁入、不修改，红线如实记录）。
> 那一阶段的记录保留在下方"红线类违规 — 整改记录"与"修复史"各节，
> 当前状态以表格的"当前状态"列为准。

## 概要

| 项 | 值 |
|:---|:---|
| 码型 | 802.11n QC-LDPC, R=1/2, N=648, K=324, Z=27 |
| 译码算法 | 归一化 Min-Sum (alpha=0.75=12/16, 移位加法), 分层行串行, max 20 迭代, syndrome 早停 |
| 编码算法 | **PT 列累加** `parity = PT * info` (GF2), ROM `rtl/pt_columns.hex` 324x324, 1 bit/cycle AXI-Stream。旧双对角回代实现对非全零信息位 H·c≠0, 已于 2026-07-31 废弃 |
| 定点格式 | LLR Q(10,4) |
| 顶层 | `ldpc_decoder_top` (主资产, manifest ports 依此登记); `ldpc_encoder_top` 为同包第二顶层 |
| Golden | `model_comm_ldpc` (engineering-assets/models/comm/ldpc/) |
| 源 | engineering-assets/knowledge/primary/domains/comm/ldpc/ |

## 包结构

```
rtl/          9 个综合源 (2 顶层 + 6 子模块 + ldpc_defines.vh)
tb/           3 个普通 TB (decoder/encoder/system 全链路) + run_sim.do (2026-07-31 已去掉旧 ../01_rtl 假设)
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
| `initial` 用于综合源（`h_matrix_addr`） | **保留**：纯常量阵列初始化，属 ROM 推断的标准写法；gate-runner G-C-03 对"仅初始化存储器阵列"的 `initial` 明确不判为违规，且该文件已由 Vivado 综合日志证实无 `[Synth 8-6896]`（未被丢弃） |
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
  加载相位与计数耦合；**2026-07-31 起已有 bit-true 基线**，可安全做 `ri_` 重构回归。
- 编码器现用 **PT 列 ROM**（`rtl/pt_columns.hex`），面积大于理想双对角；功能优先于资源。
- UVM 环境依赖本机 Vivado UVM 包路径，未纳入 gate-runner 默认路径。

## 验证证据

### 2026-07-31
- **译码器**：10 向量 **3240 bit 0 失配**，`BIT-TRUE PASS`（ModelSim 10.6c 复跑）。
- **编码器 bit-true**：5 组 MATLAB golden（`tb_enc_{info,code}_*.hex`）**5/5 PASS**。
  - 导出：`models/comm/ldpc/gen_encoder_test_vectors.m`（syndrome 自检）
  - 仿真：`+VEC_DIR=.../vectors +PT_MEM=.../rtl/pt_columns.hex`
- 旧双对角实现已替换（对非全零信息位 H·c≠0，已废弃）。

### 2026-07-28
- 编码器挂死 / initial / 命名整改；当时 TB 仅系统码性质（未覆盖校验位）。

## 门禁状态

**20/20 全绿 CERTIFIED**。实时结果见
`engineering-assets/var/gates/pg/ldpc_codec/gate-results.json`，
哈希锁定快照见 `engineering-assets/evidence/ldpc_codec/1.0.3/`。

```bash
cd engineering-assets
node tools/gate-runner.cjs cbb/ldpc_codec --repo-root ..
```
