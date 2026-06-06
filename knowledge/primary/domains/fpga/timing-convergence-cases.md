---
title: "时序收敛实战案例"
domain: fpga
tags: [timing, convergence, vivado, optimization, cases]
created: 2026-06-05
updated: 2026-06-05
difficulty: advanced
---

# 时序收敛实战案例 (15 个案例)

> 从实际通信算法 FPGA 实现中提取的时序收敛案例，覆盖 setup/hold/CDC/高扇出/布线拥塞/跨 SLR 等典型问题。

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

## Case 8: DSP48 乘法器链 — 流水线缺失

### 症状

```
WNS = -0.510 ns @ 200 MHz (5 ns 周期)
违例路径: DSP48 级联输出 → 下一级 DSP48 输入
逻辑深度: 10 级 (3 个 DSP48 + 2 级 LUT 加法)
```

### 分析

FIR 滤波器的乘累加链使用了 3 个 DSP48 级联，但未插入流水线寄存器:

```verilog
// ❌ 原始: DSP48 直连级联，无流水线
wire [47:0] dsp_out[2:0];

// DSP48 #1: a*b + c
DSP48E2 #(.PIPELINE_MODE(0)) u_dsp0 (
    .A(a0), .B(b0), .C(c0),
    .P(dsp_out[0])
);

// DSP48 #2: a*b + c + dsp_out[0] (直连!)
DSP48E2 #(.PIPELINE_MODE(0)) u_dsp1 (
    .A(a1), .B(b1), .C(c1),
    .CASCADEIN(dsp_out[0]),  // 组合级联
    .P(dsp_out[1])
);
```

分析: `PIPELINE_MODE(0)` 关闭了 DSP48 内部所有流水线寄存器，三个 DSP48 的 P 级联路径累积了 ~2.4 ns 的 48-bit 加法延迟。

### 修复

```verilog
// ✅ 修复: 打开 DSP48 内部流水线 + 外部插寄存器

// 方案 A: 使用 DSP48 内部流水线 (推荐)
DSP48E2 #(.PIPELINE_MODE(1)) u_dsp0;  // 启用内部流水线
DSP48E2 #(.PIPELINE_MODE(1)) u_dsp1;
// 内部: A/B 寄存器 (1clk) + M 寄存器 (1clk) + P 寄存器 (1clk)
// 总延迟 3 clk, 但 Fmax 大幅提升

// 方案 B: 外部级联插寄存器 (适合自定义加法树)
reg [47:0] dsp_chain_reg[1:0];
always_ff @(posedge clk) begin
    dsp_chain_reg[0] <= dsp_out[0];
    dsp_chain_reg[1] <= dsp_out[1];
end
```

### 结果

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| WNS | -0.510 ns | +0.230 ns |
| 逻辑深度 | 10 级 | 3 级 (DSP 内) |
| 延迟增加 | — | 3 时钟周期 |
| DSP 运行频率 | ≤ 200 MHz | ≥ 400 MHz |

> **关键**: DSP48 的 `PIPELINE_MODE` 是免费的性能提升。Xilinx DSP48 设计为流水线使用，内部寄存器几乎不增加面积。

---

## Case 9: 局部布线拥塞 — LUT/FF 密度过高

### 症状

```
WNS = -0.380 ns @ 150 MHz
最差路径: slice_10_25/FF2 → slice_10_30/LUT5
布线延迟占比: 72% (正常值 < 50%)
局部密度: LUT 96%, FF 88% (区域: 10 列 × 30 行)
```

### 分析

设计中的 FEC 解码模块将大量逻辑集中在一个小区域:

```tcl
# 检查拥塞区域
report_design_analysis -congestion -name congestion_map
report_utilization -pblocks pblock_fec
```

| 资源类型 | 区域总量 | 已用 | 占比 |
|:---------|:--------:|:---:|:---:|
| LUT | 8640 | 8294 | **96%** |
| FF | 17280 | 15206 | **88%** |
| 互联 (Routing) | — | — | **超过 85%** |

布线拥塞的原因:
1. LUT/FF 密度 > 85% → 布线资源竞争严重
2. 信号需要绕行到远距离路由通道
3. 局部拥塞扩散到周围区域

### 修复

```tcl
# 方案 A: Pblock 约束 + 手动展平
# 将 FEC 模块分配到更大的物理区域
create_pblock pblock_fec
add_cells_to_pblock pblock_fec [get_cells fec_decoder]
resize_pblock pblock_fec -add {SLICE_X10Y25:SLICE_X30Y100}  # 扩大 3x

# 方案 B: 综合时启用 LUT 合并减少 LUT 数
synth_design -top "[TOP_MODULE]" -part "[PART_NUM]" \
    -flatten_hierarchy rebuilt \
    -gated_clock_conversion on \
    -no_lc off  # 打开 LUT 合并

# 方案 C: 布局时指导拥塞优化
place_design -directive EarlyBlockPlacement  # 提前分布
phys_opt_design -directive CriticalCellPlacement  # 关键单元重放
```

```verilog
// ⚠ 检查原始 RTL: 是否存在不必要的大位宽多路选择
// ❌ 避免: 大位宽 case/mux 产生大量 LUT
always_comb begin
    case (sel)  // 256 选 1 → 约 128 个 LUT
        8'd0:   out <= data[0];
        8'd1:   out <= data[1];
        // ... 256 项
    endcase
end

// ✅ 改用: 分布式 RAM 或 BRAM
// LUT 实现 256:1 mux → 128 LUT + 布线拥塞
// BRAM 实现 → 1 BRAM + 零布线拥塞
```

### 结果

| 方案 | WNS | 时延改善 | 备注 |
|:----|:---:|:--------:|:-----|
| 仅 Pblock 展平 | -0.210 ns | -45% | 面积扩大 3x 有效 |
| + EarlyBlockPlacement | -0.095 ns | -75% | |
| + LUT 合并 | **+0.050 ns** | 收敛 | LUT 减少 12% |

> **关键**: 布线拥塞是"设计密度病"，定性比定量更重要。大位宽 mux 是常见罪魁祸首，改用 BRAM/DSP48 将 LUT 释放给控制逻辑。

---

## Case 10: AXI-Stream 反压路径 — valid/ready 互锁

### 症状

```
WNS = -0.280 ns @ 200 MHz
违例路径: ready_reg → valid_combo → ready_combo → valid_reg (握手互锁)
逻辑深度: 8 级 LUT
```

### 分析

AXI-Stream 的 valid/ready 握手形成组合互锁环:

```verilog
// ❌ 原始: valid/ready 组合互锁
wire                      axis_tready;
reg                       axis_tvalid;
reg [DATA_WIDTH-1:0]      axis_tdata;
wire                      fifo_ready;
wire                      fifo_valid;

// valid: 由内部状态控制，但受 ready 影响
always_comb begin
    if (axis_tready && fifo_valid)
        axis_tvalid = 1'b1;
    else if (!fifo_valid)
        axis_tvalid = 1'b0;
    // else 保持
end

// ready: 由下游 fifo 控制，但受 valid 影响
assign axis_tready = fifo_ready || !axis_tvalid;
// 互锁路径: valid → ready → valid → ready ...
```

路径分析:
```
axis_tvalid → fifo_ready (LUT1) → axis_tready (LUT2) 
→ fifo_valid (LUT3) → axis_tvalid (LUT4)
→ 跨模块信号驱动 (LUT5-8)
```

### 修复

```verilog
// ✅ 修复: 打破互锁环，插入一级寄存器

// 方案 A: ready 寄存器化 (推荐)
// 将 ready 信号寄存一级，打破组合环
reg axis_tready_reg;
always_ff @(posedge clk) begin
    axis_tready_reg <= fifo_ready || !axis_tvalid;
end
assign axis_tready = axis_tready_reg;

// 注意: 寄存 ready 会增加 1 cycle 反压响应延迟
// 但 AXI-Stream 标准允许 (ready 可寄存)

// 方案 B: 使用 skid buffer (零延迟反压)
// Skid buffer 可吸收 1 拍反压延迟，适用于高吞吐场景
skid_buffer #(.DW(DATA_WIDTH)) u_skid (
    .clk(clk),
    .rst_n(rst_n),
    .s_axis_tvalid(axis_tvalid),
    .s_axis_tready(axis_tready),
    .s_axis_tdata(axis_tdata),
    .m_axis_tvalid(fifo_valid),
    .m_axis_tready(fifo_ready),
    .m_axis_tdata(fifo_tdata)
);
```

### 结果

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| WNS | -0.280 ns | +0.150 ns |
| 组合环 LUT 深度 | 8 级 | 2 级 |
| 反压响应延迟 | 0 cycle | +1 cycle |
| 吞吐量 | 受限于 Fmax | 满速 |

> **关键**: AXI-Stream 握手的组合互锁是常见时序陷阱。**寄存 ready** 是代价最小的修复（仅增 1 FF），在大多数场景下可接受。

---

## Case 11: 分布式 RAM (LUTRAM) — 扇出过大

### 症状

```
WNS = -0.195 ns @ 125 MHz
违例路径: LUTRAM 输出 → 下游寄存器
逻辑深度: 6 级
起点扇出: 2400
```

### 分析

设计将大型查找表 (LUTRAM) 用作数据重映射表:

```verilog
// ❌ 原始: LUTRAM 输出未寄存 + 全局扇出
(* ram_style = "distributed" *)
reg [7:0] remap_table [0:4095];  // 4K × 8-bit LUTRAM

// 读逻辑
always_comb begin
    data_out = remap_table[rd_addr];  // 扇出 2400
end
```

LUTRAM 特性:
- 一个地址位扇出到 8 个 LUT (每 bit 一个) × 512 组 = 4096 个 LUT 输入
- 当 remap_table 较大时，地址信号的等效扇出极高
- 布线工具需将同一地址分发到大量分散的 LUTRAM 切片

### 修复

```verilog
// ✅ 方案 A: LUTRAM 输出加寄存器
reg [7:0] data_out_reg;
always_ff @(posedge clk) begin
    data_out_reg <= remap_table[rd_addr];
end
assign data_out = data_out_reg;

// ✅ 方案 B: 改用 BRAM (位宽 > 4K×8 时推荐)
// BRAM 的地址扇出固定 (只到 BRAM 输入端口)，不会随深度增加
// Block RAM 属性:
(* ram_style = "block" *)
reg [7:0] remap_bram [0:4095];

// 但 BRAM 有 1~2 cycle 读延迟，需要调整流水线

// ✅ 方案 C: LUTRAM 分组 + 输出寄存器
// 将大表拆为多组小表，每组带输出寄存器
// 地址高 bit 选组，低 bit 查表
reg [7:0] remap_grp0 [0:255];
reg [7:0] remap_grp1 [0:255];
// ... 16 groups

reg [7:0] grp_out [0:15];
always_ff @(posedge clk) begin
    grp_out[0] <= remap_grp0[rd_addr[7:0]];
    grp_out[1] <= remap_grp1[rd_addr[7:0]];
    // ...
end
assign data_out = grp_out[rd_addr[11:8]];
```

### 结果

| 方案 | WNS | 额外延迟 | 面积影响 |
|:----|:---:|:--------:|:--------|
| A: 输出寄存器 | +0.085 ns | +1 clk | 8 FF |
| B: BRAM 改用 | +0.310 ns | +1~2 clk | -4096 LUT + 2 BRAM |
| C: 分组 | +0.120 ns | +1 clk | ~64 FF |

> **推荐方案 B**: 当 LUTRAM 规模超过 1K×N 时，改用 BRAM 不仅解决扇出问题，还释放大量 LUT。

---

## Case 12: 时钟门控 — 时钟偏移过大

### 症状

```
WNS = -0.420 ns @ 250 MHz
最差路径分析:
  clock skew = 0.380 ns (占 WNS 的 90%)
违例路径: clk_gated_domain/FF_A → clk_gated_domain/FF_B
```

### 分析

设计中使用了时钟门控来降低功耗:

```verilog
// ❌ 原始: 门控时钟直接驱动寄存器
wire gated_clk;
assign gated_clk = clk & clk_enable;

// 门控时钟域
always_ff @(posedge gated_clk) begin
    if (clk_enable) begin
        counter <= counter + 1;
    end
end
```

时钟偏移分析:
```
clk (源时钟) → BUFG → clock_root
    → gated_clk_A (BUFGCE) → 模块 A 寄存器  (skew = 0.120 ns)
    → gated_clk_B (BUFGCE) → 模块 B 寄存器  (skew = 0.380 ns)
    → clk (直连) → 模块 C 寄存器            (skew = 0.420 ns)

原因: 门控时钟 BUFGCE 的使能信号到达时间不一致，使能转换时产生额外偏移
```

### 修复

```verilog
// ✅ 方案 A: 使能时钟 + 寄存器时钟使能 (推荐)
// 使用统一的全局时钟，通过 CE 控制，不用门控时钟
always_ff @(posedge clk) begin
    if (clk_enable) begin
        counter <= counter + 1;
    end
end
// 时钟偏移 = 0 (所有 FF 用同一个 clk)

// 方案 B: BUFGCE 使能约束 (保持门控场景)
// 约束 BUFGCE 使能路径，确保使能到达时间差异 < 100 ps
set_max_delay -from [get_pins clk_enable_reg/Q] \
              -to [get_pins bufgce_inst/CE] 0.100

// 方案 C: 时钟使能同步 (避免门控时钟)
// 如果必须用门控 (如 DDR 接口)，确保 CE 在时钟沿后稳定
reg clk_en_sync;
always_ff @(posedge clk) begin
    clk_en_sync <= clk_enable;
end
// 进一步: 需要分析 BUFGCE 的 CE 时序裕量
report_timing -from [get_pins clk_enable_reg/Q] \
              -to [get_pins bufgce_inst/CE] \
              -delay_type min_max
```

### 结果

| 方案 | WNS | 功耗 vs 原设计 | 时钟偏移 |
|:----|:---:|:-------------:|:--------:|
| 原设计 (门控) | -0.420 ns | 基准 | 0.380 ns |
| A: CE 使能 | **+0.150 ns** | +5% | **0.020 ns** |
| B: 约束门控 | -0.080 ns | 基准 | 0.120 ns |
| C: 同步使能 | -0.120 ns | 基准 | 0.180 ns |

> **关键**: 现代 FPGA (7 系列+) 的 CE 使能功耗仅比门控时钟略高，但时序大幅改善。**优先使用 CE 而非门控时钟**。

---

## Case 13: 多周期路径 — 约束遗漏

### 症状

```
WNS = -0.150 ns @ 200 MHz
但分析违例路径发现: 路径起点是慢速计数器，终点是配置寄存器
实际上只需要 8 个周期完成，却按 1 周期检查
```

### 分析

设计中有大量"慢路径": 数据不需要在 1 个周期内到达终点:

```verilog
// ❌: 配置更新计数器，实际需要 > 1 周期
reg [7:0] cfg_update_cnt;
wire cfg_update_done;

// 每 256 个时钟更新一次配置
always_ff @(posedge clk) begin
    if (cfg_update_cnt == 255) begin
        cfg_update_cnt <= 0;
        cfg_reg <= cfg_next;       // 终点
    end else begin
        cfg_update_cnt <= cfg_update_cnt + 1;
    end
end
// 起点: cfg_update_cnt + 比较器
// 终点: cfg_reg
// 实际有 255 个周期可用，但时序报告按 1 周期检查
```

还有慢速地址译码:

```verilog
// AXI-Lite 地址译码 (低频访问)
always_ff @(posedge clk) begin
    if (axi_awvalid && axi_awready) begin
        case (axi_awaddr[15:0])  // 深译码器
            ADDR_CTRL:  ctrl_reg <= axi_wdata;
            ADDR_STATUS: status_reg <= axi_wdata;
            // ... 更多译码
        endcase
    end
end
// AXI-Lite 通常 ≤ 50 MHz，且访问间隔 > 10 周期
```

### 修复

```tcl
# ✅ 修复: 对慢路径添加 multicycle 约束

# 1. 配置更新路径: 允许 128 周期
set_multicycle_path -from [get_cells cfg_update_cnt_reg*] \
    -to [get_cells cfg_reg_reg] -setup 128 -start
set_multicycle_path -from [get_cells cfg_update_cnt_reg*] \
    -to [get_cells cfg_reg_reg] -hold 127 -start

# 2. AXI-Lite 地址译码: 允许 4 周期
set_multicycle_path -from [get_cells axi_awaddr_reg*] \
    -to [get_cells *ctrl_reg*] -setup 4 -start
set_multicycle_path -from [get_cells axi_awaddr_reg*] \
    -to [get_cells *ctrl_reg*] -hold 3 -start

# 3. 验证: 检查哪些路径可设 multicycle
report_timing -unconstrainable_paths
# 输出: 列出所有可加 multicycle 约束的路径
```

```tcl
# 更激进: 对所有配置寄存器设 multicycle (使用正则)
set_multicycle_path -setup 4 -start \
    [get_timing_paths -filter {ENDPOINT_CELL_NAME =~ *cfg_*reg*}]
set_multicycle_path -hold 3 -start \
    [get_timing_paths -filter {ENDPOINT_CELL_NAME =~ *cfg_*reg*}]
```

### 结果

| 指标 | 约束前 | 约束后 |
|:----|:-----:|:-----:|
| WNS | -0.150 ns | +0.320 ns |
| 违例路径数 | 47 | 5 (真实关键路径) |
| 设计 Fmax | 182 MHz | **238 MHz** (+30%) |

> **关键**: multicycle 约束是"免费午餐"——不改变设计，只告知工具更多可用时间。配置/状态/计数路径是最常见的适合对象。

---

## Case 14: 复位释放偏移 — 恢复/移除时间违例

### 症状

```
WHS = -0.110 ns (保持时间)
report_timing -delay_type min -recovery 报出 30+ 违例
违例路径: rst_sync_reg/Q → 各模块复位端
```

### 分析

同步复位释放器输出扇出过大，导致不同 FF 接收到复位释放的时间差异:

```verilog
// ❌ 原始: 一个同步器驱动全局复位
reg [2:0] rst_sync;
always_ff @(posedge clk) begin
    rst_sync <= {rst_sync[1:0], rst_n_in};
end
wire rst_n = rst_sync[2];  // 扇出: 6000+
```

复位释放路径:
```
rst_sync[2] → 缓冲树 → FF_A (路径延迟 0.8 ns)
                        → FF_B (路径延迟 1.1 ns)
                        → FF_C (路径延迟 1.5 ns)

差异: 从第一个到最后一个释放相差 0.7 ns
→ 如果 FF_C 的复位移除时间 < 0.7 ns，则恢复时间违例
```

### 修复

```verilog
// ✅ 方案 A: 本地复位生成器 (每个模块独立)
// 将全局同步复位改为每个模块独立复位生成

// reset_controller.v
module reset_controller (
    input  clk,
    input  rst_n_in,
    output rst_n_out
);
    reg [2:0] sync;
    always_ff @(posedge clk) begin
        sync <= {sync[1:0], rst_n_in};
    end
    assign rst_n_out = sync[2];
endmodule

// 每个顶层模块例化自己的复位控制器
reset_controller u_rst_ctrl (.clk(clk), .rst_n_in(global_rst_n), .rst_n_out(local_rst_n));
// 扇出: 从 6000 → 每个模块 ~200

// ✅ 方案 B: 复位树约束 (如果必须全局复位)
set_property MAX_FANOUT 200 [get_nets rst_n]
// 指示工具插入缓冲树

// 约束复位释放路径
set_max_delay -from [get_pins rst_sync_reg[2]/Q] \
              -to [get_pins *reg_rst*] 0.500
```

### 结果

| 方案 | 恢复/移除违例 | 扇出 | 额外 FF |
|:----|:-----------:|:----:|:------:|
| 原始 | 30+ 违例 | 6000 | 0 |
| A: 本地复位器 | **0** | ~200 | 15×3 = 45 |
| B: MAX_FANOUT | 12 违例 | 分散 | 0 |

> **关键**: 全局复位网络是隐藏的时序杀手。**每个模块独立复位生成器**不仅解决时序，还提高模块化设计质量。

---

## Case 15: 跨 Die 接口 (SLR) — 超长布线延迟

### 症状

```
WNS = -0.650 ns @ 150 MHz
违例路径: SLR0 逻辑 → SLR1 逻辑
布线延迟占比: 85%
路径: SLR0_FF → SLL (Super Long Line) → SLR1_LUT
物理距离: 跨 SSIT 器件两个 SLR
```

### 分析

在大型 FPGA (VU13P/VU19P 等 SSIT 器件) 中，跨 SLR (Super Logic Region) 路径:

```
SLR0: 逻辑 A (FF) 
    → 布线到 SLR 边界 (2.0 ns)  ← 长线
    → 通过 SLL 跨 SLR (0.5 ns)  
    → 布线到 SLR1 逻辑 B (1.8 ns) ← 长线
总延迟: ~4.3 ns (其中布线 3.8 ns, 逻辑 0.5 ns)
```

```verilog
// ❌ 原始: 跨 SLR 数据在单周期内传递
// SLR0 → SLR1: 控制信号跨 SLR
always_ff @(posedge clk) begin
    slr1_enable <= slr0_state_done;  // 跨 SLR 路径
end
```

### 修复

```verilog
// ✅ 方案 A: 跨 SLR 路径插入寄存器 (乒乓结构)
// 在 SLR0 边界和 SLR1 边界各加一级寄存器

// SLR0 侧: 发送寄存器 (靠近 SLR 边界)
(* DONT_TOUCH = "TRUE" *)  // 防止综合合并
reg slr0_out_reg;
always_ff @(posedge clk) begin
    slr0_out_reg <= slr0_state_done;
end

// SLR1 侧: 接收寄存器
(* DONT_TOUCH = "TRUE" *)
reg slr1_in_reg;
always_ff @(posedge clk) begin
    slr1_in_reg <= slr0_out_reg;  // 跨 SLR 路径
end
// 总共 2 周期延迟，但 Fmax 不再受限

// ✅ 方案 B: 使用 SLR 边界专用寄存器
// Vivado 综合/布局选项
set_property SLR_ASSIGNMENT SLR0 [get_cells slr0_logic]
set_property SLR_ASSIGNMENT SLR1 [get_cells slr1_logic]

// 布局约束: 将跨 SLR 寄存器放在边界
set_property BEL SLR_BOUNDARY_REG [get_cells slr_cross_reg]

// ✅ 方案 C: 跨 SLR FIFO (推荐用于数据路径)
// 异步 FIFO 天然解耦跨 SLR 时序
xpm_fifo_async #(
    .FIFO_WRITE_DEPTH(16),
    .WRITE_DATA_WIDTH(32),
    .READ_DATA_WIDTH(32)
) u_fifo_slr_cross (
    .wr_clk(clk),
    .rd_clk(clk),          // 同频但跨 SLR
    .din(slr0_data),
    .dout(slr1_data),
    .wr_en(slr0_valid),
    .rd_en(slr1_ready),
    .full(),
    .empty()
);
```

### 结果

| 方案 | WNS | 延迟 | 备注 |
|:----|:---:|:----:|:-----|
| 原始 | -0.650 ns | 1 clk | 不可收敛 |
| A: 边界寄存器 | **+0.120 ns** | +2 clk | 最简单有效 |
| B: SLR 约束 | +0.050 ns | +1 clk | 依赖布局质量 |
| C: 异步 FIFO | **+0.350 ns** | +3 clk | **最鲁棒** |

> **关键**: 跨 SLR 路径是 SSIT 器件的固有挑战。**每跨一次 SLR，加 1~2 级寄存器**。数据路径使用异步 FIFO 避免时序耦合。

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
