# ldpc_codec 译码器 — 控制架构缺口与修复方案

> 状态: **未修复**，阻塞 G-B-03。
> 记录日期: 2026-07-25。证据来自 Vivado 2023.1 综合与 ModelSim 仿真，非推测。

## 1. 现象

用 `models/comm/ldpc/vectors/` 的黄金向量跑 `tb_ldpc_decoder_top`：

```
Test 1 / 5: Decode Test
  Loaded 648 LLRs and 324 expected bits
  Bit 0: got x, expected 1
  ...
  FAIL: 324 / 324 bit errors
```

输出全为 X，5 组向量无一通过。

> 注: 在 TB 的两处假绿修复前，同一份 RTL 报 `=== ALL TESTS PASSED ===`。
> 那是因为向量路径被截断导致 `$readmemh` 静默失败、数组从未装载而空对空比对。
> 详见 commit `10b9901`。**不要以历史上的 PASS 作为本模块可用的依据。**

## 2. 根因: 数据通路是两遍设计，控制器只驱动了一遍

`cn_update` 的 FSM 为 IDLE → PASS1 → PASS2 → IDLE：

| 相位 | 行为 |
|:--|:--|
| PASS1 | 逐边消费 `i_lq`，累积 min1/min2/符号 |
| PASS2 | 逐边输出 `o_lr` + `o_lr_valid`，**不需要输入** |

`ldpc_controller` 的 7 个状态 `IDLE/INIT/PROCESS/CHECK/ITER_INC/DONE/OUTPUT`
**没有与 PASS2 对应的写回相位**。`P_ST_PROCESS` 流完一行就转 `P_ST_CHECK`，
此后 `o_cur_row`/`o_cur_conn` 已指向别处，而 `cn_update` 才开始吐 `o_lr`。

由此派生出三处可观测的错误接线：

| # | 位置 | 现状 | 应为 |
|:--|:--|:--|:--|
| D1 | `ldpc_decoder_top.v` `w_msg_wr_addr` | `{w_cur_row, w_cur_conn}`（读遍历的当拍值） | 写回相位的 (row, pass2_idx) |
| D2 | `ldpc_decoder_top.v` `w_llr_wr_addr` | `w_h_col_addr`（读遍历流水输出） | 同上 |
| D3 | `ldpc_decoder_top.v` msg 读地址 | 当拍 `{w_cur_row,w_cur_conn}`，与 LLR 读用的 `w_h_col_addr` **差 2 拍**，却直接相减 | 同相位对齐 |

## 3. 另两处独立缺陷

**G1 — 行连接数被写死为 8**

```verilog
assign w_row_last_conn = (r_conn_cnt == (P_MAX_ROW_WT - 1));   // 固定 8
```

控制器端口表中**没有** `i_conn_count`，无从得知每行实际连接数。
本 H 矩阵每块行连接数为 `7,8,7,7,7,8,7,7,8,7,8,7`，7 连接的行会多取一个
补零槽位（col=0, shift=0），向数据通路注入不存在的边。

**G2 — msg_buffer 寻址方案与模块契约不符**

`msg_buffer.v` 头部写明：

```
地址 = row_base[row] + conn_idx        深度 P_H_NNZ = 2376
```

`ldpc_decoder_top` 实际传 `{w_cur_row, w_cur_conn}` = `row*16 + conn`：

- 位宽 13 → 端口 12，MSB 被截
- `row >= 149` 时地址即超出 2376，越界读返回 X
- X 经 `w_lq = w_llr_rd_data - w_msg_rd_data` 污染全通路 → 即第 1 节的现象

块基址（由 P 矩阵各块行连接数 ×Z=27 累加）为：

```
0, 189, 405, 594, 783, 972, 1188, 1377, 1566, 1782, 1971, 2187   (末尾 +189 = 2376)
```

与 `P_H_NNZ = 2376` **精确吻合**，可确认文档所述方案即设计本意。

## 4. 修复方案

G1、G2 判据明确。

**G2 — 已完成一半（`h_matrix_addr` 侧）**

新增输出 `o_msg_addr = r_blk_base[b] + off*cnt[b] + conn`，与 `o_col_addr` 同级
寄存。`r_blk_base` 12 项常量由 `tools/gen-ldpc-conn-tables.cjs` 与连接表同源生成。

该改动为**纯增量**：新增端口暂无消费者，不改变任何既有行为。已验证：

- 映射双射性 — 从 RTL 源码解析出的 `r_blk_base` 常量代入公式，遍历 324 行 ×
  各自连接数共 **2376** 条边，得到 **2376 个唯一地址，范围恰为 0..2375，
  无重复、无越界**（`P_H_NNZ = 2376` 相符）
- 回归 — vlog 0 错 0 警；译码器 TB 结果与改动前一致（仍 324/324，符合预期）

剩余半边：`ldpc_decoder_top` 把 msg 读/写地址切到 `o_msg_addr`。因写地址还依赖
下面 D1 的写回相位，故与方案 A/B 一并落地。

**G1 — 未实施**

控制器需增加 `i_conn_count` 输入（源 `h_matrix_addr.o_conn_count`），
`w_row_last_conn` 改用实际连接数。注意耦合：G2 的地址上界 2375 成立的前提正是
`conn < conn_count`；若仍按固定 8 遍历，7 连接行的第 8 个索引会算出 2376 而越界。
**G1 与 G2 必须同时生效。**

另需注意 `i_conn_count` 有 2 拍流水延迟：同一块行内 27 个展开行的连接数相同，
仅在块行边界处前 2 拍为上一块行的值；因比较发生在索引 ≥6 处而彼时已稳定，
逻辑上成立，但属需在仿真中确认的时序细节，故随方案一并验证。

D1–D3 需要补一个写回相位，**存在两种架构取向，需 owner 决定**：

### 方案 A — 控制器增加 `P_ST_WRITEBACK` 相位（推荐）

`P_ST_PROCESS` 流完一行后进入 `P_ST_WRITEBACK`，以 `o_lr_valid` 为节拍推进写回
计数器，用 (row, wb_cnt) 查 `h_matrix_addr` 得到列地址与 msg 地址，写回两个 buffer；
写回完成再转 `P_ST_CHECK`。

- 优点: `cn_update` 不改；控制器保持三段式；相位显式可见
- 代价: 每行多 `conn_count` 拍（吞吐降约一半），需处理 `h_matrix_addr` 的 2 拍延迟

### 方案 B — `o_lr` 先入 8 深小缓冲，再统一写回

`cn_update` 的 PASS2 输出先按 conn 索引存入 8 项数组，控制器另起相位按序写出。

- 优点: 解耦时序，地址流水易对齐
- 代价: 多一组寄存器；仍需新相位，控制器改动量与 A 相当

两方案都**不改变**算法方向（归一化最小和），不触碰 golden model。

## 5. 为什么没有直接实施

按 `rules/03-gates.md`：修复问题但正确行为无法从现有证据确定时，进入需求门禁。
D1–D3 属"写回通路未设计完整"，A/B 的取舍影响吞吐与后续时序收敛，属架构决策，
不宜由实施方单方面选定。G1/G2 判据明确，可随方案选定一并落地。

## 6. 当前门禁状态

| 门 | 状态 | 说明 |
|:--|:--|:--|
| G-A-00/01/02/04, RL-OUT, G-C-03 | pass | — |
| G-C-01 | pass | WNS +4.377ns @10ns，achieved ≈ 140MHz |
| G-C-02 | pass | lut 875/900, ff 153/500, bram 1/3, dsp 0/0 |
| **G-B-03** | **blocked** | 译码器实测 324/324 位错，不产出 bit-true 证据 |
| G-SIGN-01 | blocked | 待具名签字 |

达到级别 **QUALIFICATION**；G-B-03 未过前不得进 certified。
