---
name: ldpc-rtl-review-lessons
description: LDPC RTL 审查发现的 3 个 Bug 类型与 RTL 可靠性 checklist
metadata:
  type: learning
  domain: hdl
---

# LDPC RTL 审查经验总结

> 审查日期: 2026-06-03
> 代码库: `knowledge/primary/domains/comm/ldpc/rtl/`
> 审查规模: 9 个 RTL 文件，~1200 行

---

## 发现的 3 类 Bug

### 1. 不可综合的运算符

**文件**: `h_matrix_addr.v`
**问题**: 对非 2 次幂的 Z=27 使用 `/` 和 `%`
```verilog
assign w_block_row = ri_row / P_Z;  // 不可综合!
assign w_block_off = ri_row % P_Z;  // 不可综合!
```
**修复**: initial block 预计算 LUT
```verilog
reg [3:0] r_block_row_lut [0:323];  // row/27 的预计算结果
reg [4:0] r_block_off_lut [0:323];  // row%27 的预计算结果
initial begin
    for (ri = 0; ri < 324; ri = ri + 1) begin
        r_block_row_lut[ri] = ri / 27;
        r_block_off_lut[ri] = ri % 27;
    end
end
```
**教训**: FPGAs 中只有 2 的幂的乘除可综合，其他都必须用 LUT/移位/加法替代。`initial` 块中的运算是 elaboration-time 计算，不占硬件资源。

---

### 2. 时序逻辑竞争（CDC 类错误）

**文件**: `early_term.v`
**问题**: `i_row_start` 和 `i_row_done` 使用同一信号（`w_row_done`），在相同周期触发：
- `r_any_synd` 在 `i_row_start` 清零
- `r_any_synd` 在 `i_row_done` 置位
- 清零优先级高于置位（if-else 结构）
- 结果：综合征被清零，每个行的 `ro_early_term` 都输出 1，早停永远触发

```verilog
// 注意: 在同一个 always 块中, i_row_start 优先级高于 i_row_done
// 复合同一信号时, 清零总是吃掉置位
if (i_row_start)           r_any_synd <= 1'b0;       // 赢了
else if (i_row_done && ...) r_any_synd <= 1'b1;      // 永远执行不到
```

**修复**:
1. 将检测点从 `i_row_done`（每行）改为 `i_iter_done`（每迭代边界）
2. `r_any_synd` 不在 `i_row_start` 清零，仅在 `i_iter_done` 清零
3. 添加脉冲展宽去竞争

**教训**: Verilog 中 if-else 优先级会导致 "同拍使能竞争" 的隐藏 Bug。诊断方法：
- 检查是否同一个信号既清零又置位
- 对跨模块的脉冲信号，确认它们不会在同一拍竞争
- 迭代级信号（如 iter_done/row_done）应使用明确的脉冲展宽 + 边界检测

---

### 3. 状态机输出覆盖不足

**文件**: `ldpc_decoder_top.v`
**问题**: 译码完成后，输出逻辑只在 DONE 状态的单拍中输出 1 个比特，剩下的 323 个信息比特被丢弃：
```verilog
if (w_decode_done) begin
    ro_data  <= w_llr_rd_data[P_Q_DATA_W-1];  // 只输出 1 个 bit!
    ro_valid <= 1'b1;
end else if (...) begin
    ro_valid <= 1'b0;  // 然后回到 IDLE，结束
end
```

**修复**: 添加独立的回读扫描 FSM：
```verilog
// 译码完成后, 用专门的回读计数器扫描全部 K 个信息位
if (r_out_active) begin
    if (m_axis_data_tready || !ro_valid) begin
        ro_data  <= w_llr_rd_data[P_Q_DATA_W-1];
        if (r_out_addr == (P_K - 1))  r_out_active <= 1'b0;
        else                          r_out_addr <= r_out_addr + 1'b1;
    end
end
```

**教训**: 当数据量 > 1 时，必须检查输出状态的完整覆盖范围。判断方法：
- 如果模块输出 K 个数据，但状态机在 OUTPUT 状态只停留 1 拍 → **一定有问题**
- 输出阶段的回读地址是否独立于迭代阶段的读地址 → 需要地址 MUX

---

## 额外发现的缺漏

| 缺漏 | 风险 | 补充 |
|:----|:----|:-----|
| 只实现了译码器，无编码器 | 系统集成缺一半 | 新增 `ldpc_encoder_top.v` |
| 无系统级 TB | 链路问题无法发现 | 新增 `tb_ldpc_system.v` |
| 无仿真脚本 / 时序约束 | 无法直接投入项目使用 | 新增 `run_sim.do` + XDC |
| 报告中写 "固定迭代=8 不早停" 但实际实现了早停 | 文档与代码矛盾 | 更新报告 v2.0 |

---

## RTL 可靠性 Checklist（自用）

每次写/审查 RTL 时对照：

### 综合检查
- [ ] 所有除法/取模：分母是 2 的幂吗？→ 否则用 LUT
- [ ] `for` 循环边界是常数吗？→ 否则不可综合
- [ ] `initial` 块用于预计算吗？（仿真用）还是初始化硬件？（仅 FPGA 支持）
- [ ] `reg`/`wire` 位宽声明是否携带 `parameter` 而非魔数？
- [ ] 所有运算结果是否做了饱和/截断？

### 时序检查
- [ ] 同一个寄存器的两个使能是否可能竞争？（清零 vs 置位）
- [ ] 跨时钟域信号有同步器吗？（CDC FIFO）
- [ ] 脉冲信号是否只维持 1 拍？接收端是否能正确捕获？
- [ ] 每个 `always @(posedge clk)` 的敏感列表完整吗？

### 功能检查
- [ ] 输出状态是否覆盖所有数据？（1 拍 vs N 拍）
- [ ] 读地址和写地址会冲突吗？（RAW/WAR/WAW 冒险）
- [ ] 状态机的 default 分支是否指向安全状态（IDLE）？
- [ ] 握手信号 (valid/ready) 是否符合 AXI-Stream 规范？

---

## 相关记忆

- [[agent-evaluation-v7]] — 评价报告中 LDPC 已标记为 7 阶段全链路完成
