## 十、存储器建模规范

### 10.1 存储器模板

```verilog
reg [P_DATA_WIDTH-1:0] r_mem [0:P_DEPTH-1];

// 读操作
assign o_rd_data = r_mem[r_rd_ptr];

// 写操作
always @(posedge i_clk_sys) begin
    if (ri_wr_en && !ro_full) begin
        r_mem[r_wr_ptr] <= ri_wr_data;
    end
end
```

### 10.2 存储器初始化（对齐 UG901 / SKILL §1.2）

| 场景 | 做法 |
|:-----|:-----|
| **ROM/系数表上电初值** | `initial` + `$readmemh`/`$readmemb` 或常量 `for` 展开；可加 `rom_style`/`ram_style` |
| **RAM 上电初值** | 仅阵列 `initial`（见 `vivado-synthesis-ug901.md` §1.4）；综合后确认无 `[Synth 8-6896]` |
| **运行时清空** | 用写端口/控制状态机显式写；**不要**对大阵列做同步复位整表清零 |
| **禁止** | 对非阵列寄存器 `initial`；用 `initial` 代替 `i_rst` |
| **数据通路读寄存器** | **不加复位**（利于 BRAM 输出寄存器吸收）；无效数据由 valid 屏蔽 |

```systemverilog
// 推荐：ROM 初值
(* rom_style = "block" *) logic [P_DATA_WIDTH-1:0] r_rom [0:P_DEPTH-1];
initial $readmemh("rom.hex", r_rom);

// 推荐：同步读 BRAM（读数据寄存器无复位）
always_ff @(posedge i_clk) begin
  if (ri_we) r_mem[ri_waddr] <= ri_wdata;
  r_rdata_bram <= r_mem[ri_raddr];   // [复位豁免] BRAM 读寄存器
  ro_rdata     <= r_rdata_bram;      // [复位豁免] BRAM 输出寄存器吸收
end
```

---

## 十一、always语句使用规范
