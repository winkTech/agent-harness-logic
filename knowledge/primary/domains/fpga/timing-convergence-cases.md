---
title: "时序收敛实战案例"
domain: fpga
tags: [timing, convergence, vivado, optimization, cases]
created: 2026-06-05
updated: 2026-06-05
difficulty: advanced
---

# 时序收敛实战案例

> 从实际通信算法 FPGA 实现中提取的时序收敛案例，覆盖 setup/hold/CDC/高扇出等典型问题。

---

## 方法论总览

```
时序收敛五步法:

1. 约束正确性验证  →  check_timing (确保所有路径被约束)
2. 最差路径定位     →  report_timing -nworst 5 -setup
3. 根本原因分析     →  逻辑深度/扇出/布线拥塞/跨时钟域
4. 针对性修复       →  流水线/寄存器平衡/物理优化/约束修正
5. 收敛验证         →  迭代直到 WNS ≥ 0, TNS = 0
```

---

## Case 1: OFDM IFFT 地址生成 — 深组合逻辑

### 症状

```
WNS = -0.432 ns @ 100 MHz (10 ns 周期)
最差路径: ofdm_tx_top/gen_addr → ram_wr_addr[11] 
逻辑深度: 14 级 (7 级 LUT + 加法器链)
```

### 分析

OFDM IFFT 的地址生成包含位反转 + 子载波映射 + 循环前缀偏移，全部在同一周期完成:

```verilog
// ❌ 原始代码: 组合逻辑过深
always_comb begin
    case (mode)
        MOD_DATA:  addr = bit_reverse(sym_count, fft_len);
        MOD_CP:    addr = fft_len - cp_len + sym_count;
        MOD_PREAM: addr = preamble_map[sym_count];
    endcase
    addr = addr + base_offset;  // 再叠一层加法
end
```

### 修复

```verilog
// ✅ 修复: 插入流水线寄存器
always_ff @(posedge clk) begin
    addr_pre <= addr_pre_next;  // 第一级: 地址生成
end

always_ff @(posedge clk) begin
    addr_out <= addr_pre + base_offset;  // 第二级: 加偏移
end
```

### 结果

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| WNS | -0.432 ns | +0.125 ns |
| 逻辑深度 | 14 级 | 7 级 |
| 延迟增加 | — | 2 时钟周期 (流水线) |
| 面积增加 | — | 24 个 FF |

> **关键**: 流水线增加的延迟在设计预期内（地址提前 1~2 周期产生即可），WNS 显著改善。

---

## Case 2: 高扇出异步复位 — 全局复位树

### 症状

```
WNS = -0.215 ns @ 200 MHz (5 ns 周期)
最差路径分析显示:  75% 的路径延迟来自 clock skew
原因: 全局复位网络扇出 ~8000，导致时钟偏斜
```

### 分析

```verilog
// ❌ 原始代码: 全局同步复位，扇出极高
always_ff @(posedge clk or posedge rst) begin
    if (rst) begin
        // 8000 个 FF 使用同一个 rst 信号
        reg1 <= 0;
        reg2 <= 0;
        ...
    end
end
```

扇出 8000 → 复位缓冲树深度 8 级 → 复位到达时间差异大 → 时钟偏斜补偿困难。

### 修复

```verilog
// ✅ 方案 A: 同步复位 + 复位分发器
// 通过同步器产生本地复位，避免全局高扇出

// 本地复位生成器
reg [3:0] rst_sync;
always_ff @(posedge clk) begin
    rst_sync <= {rst_sync[2:0], global_rst_n};
end
wire local_rst_n = rst_sync[3];

// 每个模块只复位必要寄存器
always_ff @(posedge clk) begin
    if (!local_rst_n) begin
        state <= IDLE;
    end
    // 数据路径不复位 (上电初始值无所谓)
end
```

### 结果

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| WNS | -0.215 ns | +0.310 ns |
| 复位扇出 | 8000 | < 200 (按模块分布) |
| 复位释放 | 异步 | 同步 (无亚稳态) |

> **关键**: 数据路径不复位可大幅减少扇出。模块级复位通过本地复位生成器分发。

---

## Case 3: 跨时钟域 — 错误的 false path

### 症状

```
report_timing_summary: 无违例
但在实测时偶发数据错误 (约 1次/小时)
```

### 分析

设计中有两个时钟域:
- `clk_122M` (8.192 ns): OFDM 核心
- `clk_245M` (4.096 ns): DAC 接口

原始约束:

```tcl
# ❌ 错误: 直接设 false path
set_false_path -from [get_clocks clk_122M] -to [get_clocks clk_245M]
```

实际上存在 2 个 CDC 路径:
1. **配置寄存器** (从 clk_122M → clk_245M) — 这才是 false path (配置不会同时变化)
2. **IQ 数据流** (从 clk_122M → clk_245M 的异步 FIFO) — **不是 false path**，FIFO 空满标志有真实时序路径

### 修复

```tcl
# ✅ 正确: 只对配置寄存器 CDC 设 false path
set_false_path -from [get_cells -hierarchical -filter {NAME =~ *cfg_reg*} \
    -of [get_clocks clk_122M]] \
    -to [get_cells -hierarchical -filter {NAME =~ *cfg_reg*} \
    -of [get_clocks clk_245M]]

# 数据路径通过异步 FIFO 处理，是真实路径
# FIFO 的 gray code 指针路径由 Vivado CDC 分析自动处理
```

此外，在 FIFO 两侧添加 `set_max_delay` 约束确保 gray code 安全:

```tcl
set_max_delay -from [get_cells async_fifo/wr_ptr_reg*] \
              -to [get_cells async_fifo/rd_ptr_sync*] 3.000
```

### 结果

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| 偶发数据错误 | ~1次/小时 | 0 (72h 测试) |
| 时序 WNS | 无违例 (false 掩盖) | +0.087 ns |

> **关键**: CDC 路径区分"真正跨时钟域"和"真实 FIFO 路径"。错误的 false path 掩盖真实问题。

---

## Case 4: JESD204B GTY I/O — 接口时序

### 症状

```
WHS = -0.098 ns (保持时间违例)
违例路径: GTY 输出 → FPGA 逻辑 (JESD204B RX 到用户逻辑)
```

### 分析

JESD204B 的 GTY 接收侧:
- `rx_core_clk` 由 GTY 提供 (与线速率关联)
- 输出的并行数据 `rx_tdata[31:0]` 与 `rx_core_clk` 的关系由 GTY 内部确定

```tcl
# ❌ 原始约束: 缺失 GTY 输出接口约束
# vivado 自动推断接口时序，但约束不足
```

### 修复

```tcl
# ✅ 正确: 添加 GTY 输出约束

# GTY 输出时钟
create_generated_clock -name rx_core_clk \
    -source [get_pins gty_channel/RXOUTCLK] \
    -divide_by 40 \
    [get_pins rx_core_clk]

# GTY 输出数据的 I/O 延迟
# RX 输出数据在 RXOUTCLK 边沿后 0.5~0.8ns 有效 (取决于线速率)
set_output_delay -clock rx_core_clk -max 0.800 \
    [get_pins rx_tdata_reg/D]
set_output_delay -clock rx_core_clk -min 0.300 \
    [get_pins rx_tdata_reg/D]

# 使用 set_bus_skew 约束多 bit 对齐
set_bus_skew -from [get_pins gty_channel/RX_DATA*] \
    -to [get_pins rx_tdata_reg/D] 0.050
```

### 结果

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| WHS | -0.098 ns | +0.045 ns |
| GTY 数据错误 | 偶发 | 0 |
| CDC 警告 | 12 个 | 0 |

> **关键**: 高速接口（JESD204B/GTY）约束容易被忽略。`set_output_delay` + `set_bus_skew` 确保并行数据对齐。

---

## Case 5: BRAM 读路径保持时间违例

### 症状

```
WHS = -0.067 ns @ -40°C (最差工艺角 slow_slow)
违例路径: BRAM DOUT → 寄存器
```

### 分析

BRAM 读数据在时钟沿后快速变化（BRAM 内部延迟比布线延迟短），导致保持时间违例:

```verilog
// ❌ 原始: BRAM 输出直连寄存器
wire [31:0] bram_dout;
reg  [31:0] data_reg;

always_ff @(posedge clk) begin
    data_reg <= bram_dout;  // BRAM 读保持时间可能不足
end
```

### 修复

```verilog
// ✅ 修复: 在 BRAM 输出添加延迟

// 方案 A: 插入 LUT 延迟 (最直接)
// 在综合属性中添加 KEEP 防止被优化掉
(* KEEP = "TRUE" *)
wire [31:0] bram_dout_delay;
assign bram_dout_delay = bram_dout;

// 方案 B: 通过布局约束将寄存器放在 BRAM 旁边
set_property BLM_BRAM_DELAY 1 [get_cells bram_inst]
// 使 BRAM 内部输出寄存器延迟一个周期

// 方案 C: 使用 BRAM 内部输出寄存器 (最佳)
// 在 IP 配置中勾选 "Output Register" → BRAM 内含寄存器
// 这样 DOUT 到用户逻辑不再是保持时间关键路径
```

### 结果

| 方案 | WHS | 代价 |
|:----|:---:|:-----|
| 不修复 | -0.067 ns | — |
| A: LUT 延迟 | +0.012 ns | LUT 增加 |
| B: BLM 参数 | +0.031 ns | 读延迟 +1 clk |
| **C: BRAM 输出寄存器** | **+0.120 ns** | **1 clk 读延迟** |

> **推荐方案 C**: BRAM 内部输出寄存器几乎免费（BRAM 自带），且效果最好。

---

## Case 6: 多时钟域 MCP 路径 — 同步器链

### 症状

```
report_cdc: 报出 24 个 "Synchronizer chain length < 2" 警告
```

### 分析

设计中存在 24 个跨时钟域单 bit 信号（状态指示、中断标志等），使用了 1 级同步器:

```verilog
// ❌ 原始: 1 级同步器 — 亚稳态 MTBF 不足
always_ff @(posedge clk_dest) begin
    sig_sync <= sig_src;  // 单级，亚稳态概率高
end
```

### 修复

```verilog
// ✅ 修复: 2 级同步器链
reg [1:0] sig_sync;
always_ff @(posedge clk_dest) begin
    sig_sync <= {sig_sync[0], sig_src};
end
wire sig_synced = sig_sync[1];

// 或者使用同步器模块
sync_chain #(
    .STAGES(2),
    .WIDTH(1)
) u_sync (
    .clk_dst(clk_dest),
    .data_in(sig_src),
    .data_out(sig_synced)
);
```

约束:

```tcl
# ✅ 同步器设置 false path 或 max delay
set_property ASYNC_REG TRUE [get_cells -hierarchical -filter {NAME =~ *sig_sync[0]}]
set_max_delay -from [get_cells sig_src_reg] \
              -to [get_cells sig_sync_reg] 2.000
```

### 结果

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| CDC 警告 | 24 个 | 2 个 (已分析后确认安全) |
| MTBF | ~10³ 年 | ~10⁹ 年 |
| 额外 FF | 0 | 24 个 |

---

## Case 7: 综合策略选择不当 — 面积优化导致时序恶化

### 症状

```
系统自动使用默认策略综合，WNS 差但改用 Performance 策略即可收敛
```

### 分析

| 策略 | WNS | LUT | 运行时间 |
|:----|:---:|:---:|:--------:|
| Vivado Synthesis Defaults | -0.320 ns | 12450 | 3 min |
| **Performance_Optimized** | **+0.080 ns** | 12780 | 4 min |
| AreaOptimized_high | -0.510 ns | 11800 | 5 min |
| Flow_AlternateRoutability | -0.185 ns | 12500 | 3 min |

### 修复

```tcl
# ✅ 在自动化脚本中优先尝试 Performance 策略
set strategies_synth [list \
    "Performance_Optimized" \
    "Vivado Synthesis Defaults" \
    "Flow_AlternateRoutability" \
]

foreach strategy $strategies_synth {
    puts "Trying synth strategy: $strategy"
    synth_design -top $top -part $part -strategy $strategy
    set wns [get_property SLACK [get_timing_paths -max_paths 1 -nworst 1 -setup]]
    puts "  WNS = $wns"
    if {$wns >= 0} {
        puts "  ✅ Timing met with $strategy"
        break
    }
}
```

> **关键**: 不要默认使用一种策略，通过脚本自动尝试多种策略，优先时序目标。

---

## 收敛检查清单

### 综合后

- [ ] `check_timing` 无未约束路径
- [ ] `report_clock_interaction` 无意外跨时钟域
- [ ] WNS > -0.3 ns (小于此值建议优化 RTL 而非策略)
- [ ] 高扇出信号 (< 3000) 标记

### 布局后

- [ ] `report_timing -delay_type min_max` 无保持时间违例
- [ ] `report_cdc` 同步器链长度 ≥ 2
- [ ] `report_utilization -hierarchy` LUT/FF 比例 < 1.2:1
- [ ] 关键路径布线拥塞度 < 40%

### 布线后

- [ ] WNS ≥ 0, TNS = 0
- [ ] WHS ≥ 0, THS = 0
- [ ] `report_pulse_width` 无脉冲宽度违例
- [ ] `report_noise` 无串扰问题

### 比特流前

- [ ] `report_timing_summary -delay_type min_max -check_timing_verbose` 最终确认
- [ ] 多工艺角检查: slow_slow, fast_fast, slow_fast

---

## 参考

| 资源 | 说明 |
|:----|:-----|
| [时序约束指南](./timing-constraints-guide.md) | 约束编写方法 |
| [Vivado 自动化指南](./vivado-automation-guide.md) | Tcl 脚本自动化 |
| UG906 (Timing Closure Guide) | Xilinx 官方时序收敛指南 |
| UG949 (Methodology Guide) | Xilinx 设计方法论 |
| [JESD204B 指南](./jesd204b-guide.md) | GTY 接口约束 (Case 4) |
