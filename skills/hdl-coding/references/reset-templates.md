## 十四、复位规范

### 14.1 复位策略选择

| 场景 | 推荐策略 | 说明 |
|------|----------|------|
| 数据路径 | 无复位 | 面积最优，时序最优 |
| 控制逻辑 | 同步复位 | 高电平有效 |
| 必须复位 | 异步复位同步释放 | 仅用于上电初始化 |

### 14.2 异步复位同步释放模板

```verilog
reg r_rst_sync;

always @(posedge i_clk_sys or posedge i_rst_async) begin
    if (i_rst_async) begin
        r_rst_sync <= 1'b1;
    end else begin
        r_rst_sync <= 1'b0;
    end
end

always @(posedge i_clk_sys) begin
    if (r_rst_sync) begin
        r_data <= 'd0;
    end else begin
        r_data <= i_data;
    end
end
```

---

## 十五、时钟规范
