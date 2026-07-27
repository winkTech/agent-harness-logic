// ⛔ SUPERSEDED (2026-07-27): 修复前旧版。权威版本:
// engineering-assets/incubator/intake/ldpc_codec/ (bit-true 0 失配)。
// 禁止引用/复制/例化; 详见 ../_SUPERSEDED.md。仅作历史对照保留。
//-----------------------------------------------------------------
//                    Check Node Update Module (Min-Sum)
//-----------------------------------------------------------------
// 功能描述: Min-Sum 校验节点更新 (α=0.75, Q(10,4) 定点)
//
// 两遍处理 (per row):
//   第一遍 (PASS1): 逐个连接计算 |L_q|, 累积 min1/min2/prod_sign
//   第二遍 (PASS2): 逐个连接计算 L_r = α × min_other × sign
//
// 定点公式:
//   |L_r| = floor(min_val × 12 / 16)  (移位加法, 无乘法器)
//         = ((min_val << 3) + (min_val << 2)) >> 4
//   sign(L_r) = prod_sign XOR sign(L_q)
//-----------------------------------------------------------------
// 主要逻辑:
//   1. 状态机: IDLE → PASS1 → PASS2 → IDLE
//   2. PASS1: 缓存 L_q, 逐连接更新 min1/min2/prod_sign
//   3. PASS2: 选 min1/min2, α 缩放, 组合符号, 输出 L_r
//-----------------------------------------------------------------

module cn_update #(
    parameter P_Q_DATA_W         = 10,
    parameter P_MAX_ROW_WT       = 8,
    parameter P_CONN_CNT_W       = 4,
    parameter P_ALPHA_FIXED      = 12,
    parameter P_Q_SCALE          = 16
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    input  wire signed [P_Q_DATA_W-1:0]     i_lq,
    input  wire                             i_valid,
    input  wire [P_CONN_CNT_W-1:0]          i_conn_idx,
    input  wire                             i_row_start,
    input  wire [P_CONN_CNT_W-1:0]          i_conn_count,

    output wire signed [P_Q_DATA_W-1:0]     o_lr,
    output wire                             o_lr_valid
);

    //-----------------------------------------------------------------
    // 两遍处理状态 (独热码)
    //-----------------------------------------------------------------
    localparam P_CN_IDLE       = 3'b001;
    localparam P_CN_PASS1      = 3'b010;
    localparam P_CN_PASS2      = 3'b100;

    //-----------------------------------------------------------------
    // 输入寄存器
    //-----------------------------------------------------------------
    reg signed [P_Q_DATA_W-1:0] ri_lq;
    reg                          ri_valid;
    reg [P_CONN_CNT_W-1:0]      ri_conn_idx;
    reg                          ri_row_start;
    reg [P_CONN_CNT_W-1:0]      ri_conn_count;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_lq         <= 'd0;
            ri_valid      <= 1'b0;
            ri_conn_idx   <= 'd0;
            ri_row_start  <= 1'b0;
            ri_conn_count <= 'd0;
        end else begin
            ri_lq         <= i_lq;
            ri_valid      <= i_valid;
            ri_conn_idx   <= i_conn_idx;
            ri_row_start  <= i_row_start;
            ri_conn_count <= i_conn_count;
        end
    end

    //-----------------------------------------------------------------
    // 两遍处理状态机
    //-----------------------------------------------------------------
    reg [2:0]                    r_cn_state;
    reg [2:0]                    r_cn_nxt_state;
    reg [P_CONN_CNT_W-1:0]      r_pass1_cnt;
    reg [P_CONN_CNT_W-1:0]      r_pass2_cnt;

    wire w_pass1_done;
    wire w_pass2_done;

    assign w_pass1_done = (r_cn_state == P_CN_PASS1) && (r_pass1_cnt == ri_conn_count);
    assign w_pass2_done = (r_cn_state == P_CN_PASS2) && (r_pass2_cnt == ri_conn_count);

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_cn_state <= P_CN_IDLE;
        end else begin
            r_cn_state <= r_cn_nxt_state;
        end
    end

    always @(*) begin
        r_cn_nxt_state = r_cn_state;

        case (r_cn_state)
            P_CN_IDLE: begin
                if (ri_row_start) begin
                    r_cn_nxt_state = P_CN_PASS1;
                end
            end

            P_CN_PASS1: begin
                if (w_pass1_done) begin
                    r_cn_nxt_state = P_CN_PASS2;
                end
            end

            P_CN_PASS2: begin
                if (w_pass2_done) begin
                    r_cn_nxt_state = P_CN_IDLE;
                end
            end

            default: begin
                r_cn_nxt_state = P_CN_IDLE;
            end
        endcase
    end

    //-----------------------------------------------------------------
    // PASS1/PASS2 计数器
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_pass1_cnt <= 'd0;
            r_pass2_cnt <= 'd0;
        end else begin
            case (r_cn_nxt_state)
                P_CN_PASS1: begin
                    if (r_cn_state == P_CN_PASS1 && ri_valid) begin
                        r_pass1_cnt <= r_pass1_cnt + 1'b1;
                    end else if (r_cn_state != P_CN_PASS1) begin
                        r_pass1_cnt <= 'd0;
                    end
                end

                P_CN_PASS2: begin
                    if (r_cn_state == P_CN_PASS2) begin
                        r_pass2_cnt <= r_pass2_cnt + 1'b1;
                    end else begin
                        r_pass2_cnt <= 'd0;
                    end
                end

                default: begin
                    r_pass1_cnt <= 'd0;
                    r_pass2_cnt <= 'd0;
                end
            endcase
        end
    end

    //-----------------------------------------------------------------
    // |L_q| 和 sign(L_q) 提取
    //-----------------------------------------------------------------
    wire [P_Q_DATA_W-1:0]      w_abs_lq;
    wire                        w_sign_lq;

    assign w_abs_lq  = ri_lq[P_Q_DATA_W-1] ? (~ri_lq + 1'b1) : ri_lq;
    assign w_sign_lq = ri_lq[P_Q_DATA_W-1];

    //-----------------------------------------------------------------
    // PASS1 累加器: min1, min2, prod_sign
    //-----------------------------------------------------------------
    reg  [P_Q_DATA_W-1:0]       r_min1;
    reg  [P_Q_DATA_W-1:0]       r_min2;
    reg  [P_CONN_CNT_W-1:0]     r_min1_idx;
    reg                          r_prod_sign;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_min1      <= {P_Q_DATA_W{1'b1}};
            r_min2      <= {P_Q_DATA_W{1'b1}};
            r_min1_idx  <= 'd0;
            r_prod_sign <= 1'b0;
        end else begin
            if (ri_row_start) begin
                r_min1      <= {P_Q_DATA_W{1'b1}};
                r_min2      <= {P_Q_DATA_W{1'b1}};
                r_min1_idx  <= 'd0;
                r_prod_sign <= 1'b0;
            end else if (r_cn_state == P_CN_PASS1 && ri_valid) begin
                r_prod_sign <= r_prod_sign ^ w_sign_lq;

                if (w_abs_lq < r_min1) begin
                    r_min2     <= r_min1;
                    r_min1     <= w_abs_lq;
                    r_min1_idx <= ri_conn_idx;
                end else if (w_abs_lq < r_min2) begin
                    r_min2 <= w_abs_lq;
                end
            end
        end
    end

    //-----------------------------------------------------------------
    // L_q 缓存 (用于 PASS2 读取原始符号)
    //-----------------------------------------------------------------
    reg signed [P_Q_DATA_W-1:0] r_lq_buf [0:P_MAX_ROW_WT-1];

    always @(posedge i_clk_sys) begin
        if (r_cn_state == P_CN_PASS1 && ri_valid) begin
            r_lq_buf[ri_conn_idx] <= ri_lq;
        end
    end

    //-----------------------------------------------------------------
    // PASS2: 计算 L_r
    //-----------------------------------------------------------------
    // 选择 min1 或 min2 (当前连接==min1_idx 则用 min2)
    wire [P_Q_DATA_W-1:0]      w_min_sel;
    assign w_min_sel = (r_pass2_cnt == r_min1_idx) ? r_min2 : r_min1;

    // α 缩放: |L_r| = floor(min × 12 / 16)
    // L_r unsigned magnitude before sign
    wire [P_Q_DATA_W+3:0]      w_lr_mag_full;
    wire [P_Q_DATA_W-1:0]      w_lr_mag;

    assign w_lr_mag_full = ({3'b0, w_min_sel, 3'b0} + {4'b0, w_min_sel, 2'b0});
    assign w_lr_mag      = w_lr_mag_full[P_Q_DATA_W+3:4];

    // 符号: sign(L_r) = prod_sign XOR sign(L_q_buf)
    wire                        w_lq_sign_buf;
    wire                        w_lr_sign;
    assign w_lq_sign_buf = r_lq_buf[r_pass2_cnt][P_Q_DATA_W-1];
    assign w_lr_sign     = r_prod_sign ^ w_lq_sign_buf;

    // L_r = sign ? -|L_r| : +|L_r|
    wire signed [P_Q_DATA_W-1:0] w_lr;
    assign w_lr = w_lr_sign ? (~w_lr_mag + 1'b1) : w_lr_mag;

    //-----------------------------------------------------------------
    // 输出寄存器
    //-----------------------------------------------------------------
    reg signed [P_Q_DATA_W-1:0] ro_lr;
    reg                          ro_lr_valid;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_lr       <= 'd0;
            ro_lr_valid <= 1'b0;
        end else begin
            ro_lr       <= w_lr;
            ro_lr_valid <= (r_cn_state == P_CN_PASS2);
        end
    end

    assign o_lr       = ro_lr;
    assign o_lr_valid = ro_lr_valid;

endmodule
