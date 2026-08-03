//-----------------------------------------------------------------
//                    Check Node Update Module (Min-Sum)
//-----------------------------------------------------------------
// 功能描述: 归一化 Min-Sum 校验节点更新 (α=12/16, Q(10,4) 定点)
//
// 与 golden 的对应关系 (models/comm/ldpc/src/ldpc_decoder_ms_fixed.m L61-91):
//   abs_q = |L_q|;  signs = sign(L_q), sign(0) 取 +1
//   [min1, min1_idx] = min(abs_q)        <- 取首个最小值的位置
//   min2 = min(abs_q 去掉 min1_idx 那个位置)
//   prod_sign = prod(signs)
//   对每条边 j:  mv  = (j == min1_idx) ? min2 : min1
//                L_r = floor(mv * 12 / 16) * prod_sign * signs(j)
//   位形式: sign_bit(L_r) = prod_sign_bit XOR sign_bit(L_q(j))
//           (prod_sign 含 j 自身, 再异或 signs(j) 即"除 j 外全体之积")
//
//-----------------------------------------------------------------
// 架构变更 (相对原实现)
//
// 原实现内部有 IDLE→PASS1→PASS2 状态机自行推进 PASS2, 与顶层控制器各走各的
// 节拍, 两者永久失步: 控制器每行只给 conn_count 拍, 而本模块一行要
// PASS1+PASS2 ≈ 2 倍拍数, 且 PASS2 状态臂不响应 i_row_start, 期间到达的边被
// 静默丢弃。另有两处独立缺陷: 完成判据 (r_pass2_cnt == conn_count) 比实际多
// 一拍, 8 连接行会读 r_lq_buf[8] 越界返回 X; PASS1 在 done 置起那拍仍把该拍
// 的 ri_lq 算进 min1/min2。
//
// 现改为**无自主状态机**: 累加相位与写回相位都由顶层控制器给节拍。
//   READ 相位 (i_acc_en): 累加 min1/min2/prod_sign, 并把 L_q 存进 r_lq_buf
//   WB   相位 (i_wb_en) : 按 i_wb_idx 查表, 寄存输出 L_r 与对应的 L_q
// 顶层负责保证 READ 全部结束(含流水排空)后才发第一个 i_wb_en。
// 这样"相位对齐"成为顶层一处显式约束, 而不是两个状态机的隐式默契。
//
// 一并输出 o_lq: 写回时需要 sat(L_q + L_r), 而 L_q 只有本模块缓存着。让本
// 模块把它随 o_lr 一起吐出, 顶层就不必在写回相位重读存储器再对齐一次相位。
//-----------------------------------------------------------------

module cn_update #(
    parameter P_LQ_W             = 12,   // L_q 位宽 (signed)
    parameter P_LR_W             = 12,   // L_r 位宽 (signed)
    parameter P_MAG_W            = 11,   // |L_q| / min 位宽 (unsigned)
    parameter P_MAX_ROW_WT       = 8,
    parameter P_CONN_CNT_W       = 4,
    parameter P_ALPHA_FIXED      = 12    // α = P_ALPHA_FIXED / 16
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    // 行起始脉冲: 清累加器
    input  wire                             i_row_start,

    // READ 相位: 逐条边累加
    input  wire                             i_acc_en,
    input  wire signed [P_LQ_W-1:0]         i_lq,
    input  wire [P_CONN_CNT_W-1:0]          i_conn_idx,

    // WB 相位: 请求第 i_wb_idx 条边的结果
    input  wire                             i_wb_en,
    input  wire [P_CONN_CNT_W-1:0]          i_wb_idx,

    // 寄存输出, 比请求晚 1 拍
    output wire signed [P_LR_W-1:0]         o_lr,
    output wire signed [P_LQ_W-1:0]         o_lq,
    output wire                             o_wb_valid
);

    //-----------------------------------------------------------------
    // 输入寄存 (红线1)
    //-----------------------------------------------------------------
    reg                          ri_row_start;
    reg                          ri_acc_en;
    reg signed [P_LQ_W-1:0]      ri_lq;
    reg [P_CONN_CNT_W-1:0]       ri_conn_idx;
    reg                          ri_wb_en;
    reg [P_CONN_CNT_W-1:0]       ri_wb_idx;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_row_start <= 1'b0;
            ri_acc_en    <= 1'b0;
            ri_lq        <= {P_LQ_W{1'b0}};
            ri_conn_idx  <= {P_CONN_CNT_W{1'b0}};
            ri_wb_en     <= 1'b0;
            ri_wb_idx    <= {P_CONN_CNT_W{1'b0}};
        end else begin
            ri_row_start <= i_row_start;
            ri_acc_en    <= i_acc_en;
            ri_lq        <= i_lq;
            ri_conn_idx  <= i_conn_idx;
            ri_wb_en     <= i_wb_en;
            ri_wb_idx    <= i_wb_idx;
        end
    end

    //-----------------------------------------------------------------
    // |L_q| 与 sign(L_q)
    //  sign(0) = +1: ri_lq[MSB] 对 0 恰为 0(正), 与 golden L64 的
    //  signs(signs==0)=1 一致。
    //-----------------------------------------------------------------
    wire                         w_sign_lq;
    wire [P_MAG_W-1:0]           w_abs_lq;

    assign w_sign_lq = ri_lq[P_LQ_W-1];
    assign w_abs_lq  = w_sign_lq ? (~ri_lq[P_MAG_W-1:0] + 1'b1) : ri_lq[P_MAG_W-1:0];

    //-----------------------------------------------------------------
    // 累加器: min1 / min2 / min1_idx / prod_sign
    //
    // 流式更新与 golden 的"取首个最小值位置"等价: 用严格小于比较, 后到的
    // 相等值不会顶替 min1_idx; 相等值会落进 min2 分支, 与 golden 只按位置
    // 排除 min1_idx 的结果一致。
    //-----------------------------------------------------------------
    localparam [P_MAG_W-1:0] P_MAG_MAX = {P_MAG_W{1'b1}};

    reg [P_MAG_W-1:0]            r_min1;
    reg [P_MAG_W-1:0]            r_min2;
    reg [P_CONN_CNT_W-1:0]       r_min1_idx;
    reg                          r_prod_sign;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_min1      <= P_MAG_MAX;
            r_min2      <= P_MAG_MAX;
            r_min1_idx  <= {P_CONN_CNT_W{1'b0}};
            r_prod_sign <= 1'b0;
        end else if (ri_row_start) begin
            r_min1      <= P_MAG_MAX;
            r_min2      <= P_MAG_MAX;
            r_min1_idx  <= {P_CONN_CNT_W{1'b0}};
            r_prod_sign <= 1'b0;
        end else if (ri_acc_en) begin
            r_prod_sign <= r_prod_sign ^ w_sign_lq;
            if (w_abs_lq < r_min1) begin
                r_min2     <= r_min1;
                r_min1     <= w_abs_lq;
                r_min1_idx <= ri_conn_idx;
            end else if (w_abs_lq < r_min2) begin
                r_min2     <= w_abs_lq;
            end
        end
    end

    //-----------------------------------------------------------------
    // L_q 缓存 (写回相位要用原始 L_q 的符号, 以及 sat(L_q+L_r) 的加数)
    //-----------------------------------------------------------------
    reg signed [P_LQ_W-1:0]      r_lq_buf [0:P_MAX_ROW_WT-1];

    always @(posedge i_clk_sys) begin
        if (ri_acc_en) begin
            r_lq_buf[ri_conn_idx] <= ri_lq;
        end
    end

    //-----------------------------------------------------------------
    // 写回相位: 组合算出该条边的 L_r, 下一拍寄存输出
    //-----------------------------------------------------------------
    wire [P_MAG_W-1:0]           w_min_sel;
    wire [P_MAG_W+3:0]           w_mag_x12;
    wire [P_MAG_W-1:0]           w_lr_mag;
    wire signed [P_LQ_W-1:0]     w_lq_sel;
    wire                         w_lr_sign;
    wire signed [P_LR_W-1:0]     w_lr;

    assign w_min_sel = (ri_wb_idx == r_min1_idx) ? r_min2 : r_min1;

    // |L_r| = floor(min * 12 / 16) = ((min<<3) + (min<<2)) >> 4, 无乘法器
    assign w_mag_x12 = {3'b0, w_min_sel, 3'b0} + {4'b0, w_min_sel, 2'b0};
    assign w_lr_mag  = w_mag_x12[P_MAG_W+3:4];

    assign w_lq_sel  = r_lq_buf[ri_wb_idx];
    assign w_lr_sign = r_prod_sign ^ w_lq_sel[P_LQ_W-1];
    assign w_lr      = w_lr_sign ? -$signed({{(P_LR_W-P_MAG_W){1'b0}}, w_lr_mag})
                                 :  $signed({{(P_LR_W-P_MAG_W){1'b0}}, w_lr_mag});

    //-----------------------------------------------------------------
    // 输出寄存 (红线2)
    //-----------------------------------------------------------------
    reg signed [P_LR_W-1:0]      ro_lr;
    reg signed [P_LQ_W-1:0]      ro_lq;
    reg                          ro_wb_valid;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_lr       <= {P_LR_W{1'b0}};
            ro_lq       <= {P_LQ_W{1'b0}};
            ro_wb_valid <= 1'b0;
        end else begin
            ro_lr       <= w_lr;
            ro_lq       <= w_lq_sel;
            ro_wb_valid <= ri_wb_en;
        end
    end

    assign o_lr       = ro_lr;
    assign o_lq       = ro_lq;
    assign o_wb_valid = ro_wb_valid;

endmodule
