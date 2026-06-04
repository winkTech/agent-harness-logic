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

### 10.2 存储器初始化

- 仿真初始化：使用 `initial` 块初始化
- 综合初始化：使用复位信号初始化（如需要）
- 复位时采用 `{default:'d0}` 语法初始化数组

---

## 十一、always语句使用规范
