## 七、状态机设计规范

### 7.1 设计要求

- 必须包含default分支
- 当前计算逻辑到下个时钟周期才可使用
- 通常采用三段式进行设计
- 使用localparam定义状态
- 状态转换逻辑清晰

### 7.2 三段式状态机模板

```verilog
// 状态定义
localparam P_ST_IDLE  = 2'b00;
localparam P_ST_READ  = 2'b01;
localparam P_ST_WRITE = 2'b10;
localparam P_ST_DONE  = 2'b11;

// 状态寄存器
reg [1:0] r_cur_state;
reg [1:0] r_nxt_state;

// 第一段：状态寄存器（时序逻辑）
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_cur_state <= P_ST_IDLE;
    end else begin
        r_cur_state <= r_nxt_state;
    end
end

// 第二段：状态转移逻辑（组合逻辑）
always @(*) begin
    case (r_cur_state)
        P_ST_IDLE: begin
            if (ri_valid) begin
                r_nxt_state = P_ST_READ;
            end else begin
                r_nxt_state = P_ST_IDLE;
            end
        end
        P_ST_READ: begin
            r_nxt_state = P_ST_WRITE;
        end
        P_ST_WRITE: begin
            r_nxt_state = P_ST_DONE;
        end
        P_ST_DONE: begin
            r_nxt_state = P_ST_IDLE;
        end
        default: begin
            r_nxt_state = P_ST_IDLE;
        end
    endcase
end

// 第三段：输出逻辑（时序逻辑）
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        ro_result <= 'd0;
        ro_valid  <= 1'b0;
    end else begin
        case (r_nxt_state)
            P_ST_READ: begin
                ro_result <= ri_data;
            end
            P_ST_WRITE: begin
                ro_valid <= 1'b1;
            end
            default: begin
                ro_valid <= 1'b0;
            end
        endcase
    end
end
```

### 7.3 状态编码选择建议

| 状态个数 | 推荐编码 | 说明 |
|---------|---------|------|
| ≤ 5 | 二进制码 | 使用最少触发器 |
| 5~50 | 独热码 | 组合逻辑少，易时序收敛 |
| > 50 | 格雷码 | 低功耗设计 |

---

## 八、流水线设计规范
