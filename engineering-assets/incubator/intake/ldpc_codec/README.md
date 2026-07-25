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

## 如实记录的红线类违规 (未修复)

1. **红线1 输入未寄存直用**: `ldpc_decoder_top.v:93` 直接用 `s_axis_llr_tvalid` 计数 (寄存版 `ri_llr_valid/ri_llr_data` 声明后未使用); `ldpc_encoder_top.v:152/171/200-201` 直接用 `s_axis_info_tvalid/tdata`; `early_term.v:36-39`、`llr_buffer.v`/`msg_buffer.v` 读地址均未寄存。
2. **红线2 组合直出**: `ldpc_decoder_top.v:103` `s_axis_llr_tready = ~r_llr_load_done`; `ldpc_encoder_top.v:275` `s_axis_info_tready = (state==S_IDLE)||(state==S_LOAD)`; `llr_buffer.v:33` / `msg_buffer.v:34` 组合读直出 `o_rd_data`。
3. **红线4/5 case 缺 default**: `ldpc_encoder_top.v:151-157` 次态 case 无 default 分支 (有前置默认赋值, 无锁存, 但违反规范)。
4. **initial 用于综合源 (G-C-03)**: `h_matrix_addr.v:64/117/132`, `ldpc_encoder_top.v:49/84` 用 initial 初始化 ROM/LUT — 仿真-综合差异源。
5. **命名违规**: `ldpc_encoder_top.v` 内部信号 `state/nxt/bit_cnt/blk/conn/info/par/lambda` 无 r_/w_ 前缀, localparam `N/K/M/Z/...`、`S_IDLE/...` 无 P_ 前缀。

## 结构性缺陷 (功能疑点, 如实暴露)

- **LLR 加载路径断裂**: `ldpc_decoder_top.v` 中 `ri_llr_data/ri_llr_valid` 寄存后从未连接到 `llr_buffer` 写口 (写口仅由迭代回写驱动) — 输入 LLR 疑似永远进不了缓存, 译码器无法产生正确结果。
- **隐式 1-bit 线网**: `ldpc_decoder_top.v:170/201` 使用未声明的 `w_h_conn_count` (声明的是 `w_conn_count`, 行58), 4-bit conn_count 被截为 1-bit 隐式 wire。
- **TB 向量缺失**: `tb_ldpc_decoder_top.v` 依赖 `tb_llr_input_*.hex` / `tb_expected_output_*.hex` (由 golden `gen_rtl_test_vectors.m` 生成), 但源知识库全树无任何 .hex — TB 不可独立复跑。
- `tb/run_sim.do`、`tb/uvm/compile.tcl` 中的相对路径仍指向源库旧布局 (`../01_rtl/`), 迁包后未改 (评估性打包不改动)。

## 门禁状态

见 `engineering-assets/var/gates/pg/ldpc_codec/gate-results.json` (由 `node engineering-assets/tools/gate-runner.cjs engineering-assets/incubator/intake/ldpc_codec` 生成)。
