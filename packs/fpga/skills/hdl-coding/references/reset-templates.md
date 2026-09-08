## 十四、复位规范

### 14.1 复位策略选择（对齐 UG949 / SKILL §1.1）

| 场景 | 推荐策略 | 说明 |
|------|----------|------|
| **纯数据通路流水** | **无复位（默认）** | 由 valid 屏蔽；少复位 → 控制集少、利于 Fmax 与宏吸收 |
| FSM / valid / 指针 / 计数器 | 同步复位高有效 `i_rst` | 必须进入已知控制态 |
| BRAM 读/输出、DSP 流水、SRL 中间级 | **禁止加复位** | 硬豁免；见 `vivado-synthesis-ug901.md` §5.1 |
| 片外异步复位源 | 异步断言 + **同步释放** | 仅复位同步器；功能逻辑仍用同步 `i_rst` |

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
