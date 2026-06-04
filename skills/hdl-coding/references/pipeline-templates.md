## 八、流水线设计规范

### 8.1 设计要求

- 寄存器隔离每级计算
- valid信号严格同步传递
- 复位清除所有流水状态
- 计算位宽自动扩展

### 8.2 流水线模板

```verilog
reg [7:0] r_pipe_data [0:2];
reg       r_pipe_valid [0:2];

// 流水线第一级
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_pipe_data[0]  <= 'd0;
        r_pipe_valid[0] <= 1'b0;
    end else begin
        r_pipe_data[0]  <= ri_data;
        r_pipe_valid[0] <= ri_valid;
    end
end

// 流水线第二级
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_pipe_data[1]  <= 'd0;
        r_pipe_valid[1] <= 1'b0;
    end else begin
        r_pipe_data[1]  <= r_pipe_data[0] + 1;
        r_pipe_valid[1] <= r_pipe_valid[0];
    end
end

// 流水线第三级
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_pipe_data[2]  <= 'd0;
        r_pipe_valid[2] <= 1'b0;
    end else begin
        r_pipe_data[2]  <= r_pipe_data[1] * 2;
        r_pipe_valid[2] <= r_pipe_valid[1];
    end
end

assign o_data  = r_pipe_data[2];
assign o_valid = r_pipe_valid[2];
```

---

## 九、参数化设计规范
