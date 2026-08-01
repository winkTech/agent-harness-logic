# CHANGELOG — ddr_axi4_controller

## [1.0.0] — 2026-08-01 certified 认证（含 TB 竞争修复）

### 关键事实：该模块此前从未被真正验证过

G-B-03 一直是 `blocked`（`tb-selfcheck.json` 从未生成），意味着自 2026-07-27
入库以来**没有任何实跑证据** —— "qualification" 是靠 G-A-*/CS-* 这些静态门
拿到的。本次把自检 TB 第一次跑起来，立刻暴露问题。

### TB 竞争缺陷（本版修复；RTL 无缺陷）

首跑结果 FAIL：`rd_last` 大量错位（`beat=0/1`、`beat=15/16`），读回数据整体
移位一拍（`got[k] == expected[k-1]`）。

**诊断过程（四步定位，每步都有实测）**：

| 实验 | 从机驱动沿 | 反压 | 结果 |
|:--|:--|:--|:--|
| 独立最小探针（恒 ready 从机） | negedge | 无 | **DUT 正确**（len=1/3 逐拍核对） |
| 包内 TB（git HEAD 原始版） | posedge | 有 | 87 失配 |
| 包内 TB（扩展版） | posedge | 有 | 280 失配 |
| 包内 TB | posedge | **关** | 298 失配 → **与反压无关** |
| 包内 TB | **negedge** | 有 | **0 失配** |

**根因**：TB 的读从机模型在 posedge 之后用**阻塞赋值**驱动
`rvalid`/`rdata_s`/`rlast`，与 DUT 自身的 `always_ff @(posedge clk)` 处于
**同一时间步**，两个进程执行顺序不确定 —— DUT 有时采到下一拍的数据与末拍
标记。这解释了全部三个症状（末拍错位、数据移位一拍、图样随机）。

**排除项**（诊断中逐一验证）：`m_axi_awlen`/`m_axi_arlen` 的 AXI 语义正确
（`ri_len-1`，符合 LEN=拍数−1）；读输出寄存 `ro_rd_valid` 与
`ro_rd_last`/`ro_rd_data` 同拍寄存、对齐。**RTL 未做任何改动。**

修复：R 通道一律改在 negedge 驱动，并在 TB 内注明原因，防止后续回退。

### 新增

- `constraints/ddr_axi4_controller.xdc`；manifest 补 `device.part`、`params`
  与资源预算（事先按结构推算）。
- `docs/limitations.md`。
- TB 扩展：60 事务浸泡、分场景计数、证据落盘、19 个寄存器复位审计；
  修正审计中一处期望值（`ri_len` 复位值是 `9'd1` 而非 0）。

### 实测

- **778 拍读回比对 0 失配**（随机退避从机常开）
- 分场景：regression 188 / boundary 17 / stress 551 / backpressure 778
- 逐寄存器复位比对：19 个寄存器 0 失配
- 错误路径覆盖：`bresp=SLVERR` 注入（`o_err` 置位且粘滞、下一命令成交后清）、
  AR 静默超时（`o_err` 置位、撤 AXI valid 回空闲、恢复后旧数据仍可读）
- AXI 协议不变量：`valid && !ready` 期间 AW/W/AR 载荷不变、`wlast` 恰落最后一拍、
  `i_calib_done` 未置位期间 `o_cmd_ready` 必须保持低

## [0.1.0] — 2026-07-27 入库(批次 3, primitive 路径)

- 重写修七条缺陷(写通路无数据流接口/awlen-wlast 拍数矛盾/红线 1/2/3/5/
  超时静默/write_nread 命名语义反);TB 内建行为级 AXI4 从机(关联数组存储器+
  随机退避),198 拍读回 0 失配,超时保护与 SLVERR 路径实测。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
