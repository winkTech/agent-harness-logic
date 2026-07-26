//                    LDPC Decoder Top Module
// 功能描述: 802.11n QC-LDPC 归一化 Min-Sum 分层译码器顶层
//
// 参数: N=648, K=324, M=324, Z=27, LLR Q(10,4), α=12/16, max_iter=20
// 接口: AXI4-Stream 简化版 (LLR 逐个入, 硬判决逐位出)
//
// 子模块: h_matrix_addr(地址) / llr_buffer / msg_buffer / cn_update(CN 运算)
//         ldpc_controller(相位机) / ldpc_stream_io(AXI 收发)
//
// 相位与流水: 控制器节拍 T0 -> T0+2 出地址 -> T0+3 存储器数据到位。
//   READ 用延迟 3 拍的 conn 索引喂 cn_update; WB 的 i_wb_en 与 i_en 同拍发出,
//   两者都在 T0+2 产出, 天然对齐; SYND 只读 LLR 符号位逐行异或。
//   完整契约(含排空拍数依据)见 README.md "控制架构"。
//
// 位宽依据 (models/comm/ldpc/measure_ranges.m 实测 10 组向量 80784 条边):
//   LLR_total 10b (参考模型饱和到 [-512,511], 精确) / L_r 12b (实测 ±210,
//   理论上界 1536) / L_q 13b (实测 ±591, 理论上界 2048)。
//   原实现把 L_q 也当成 10 位, 实测在 ±591 处静默回绕。
//-----------------------------------------------------------------

module ldpc_decoder_top #(
    parameter P_MAX_ROW_WT       = 8,
    parameter P_Q_DATA_W         = 10,   // LLR_total / 通道 LLR
    parameter P_LR_W             = 12,   // L_r (msg_buffer)
    parameter P_LQ_W             = 13,   // L_q 内部
    parameter P_MAG_W            = 12,   // |L_q| / min
    parameter P_LLR_ADDR_W       = 10,
    parameter P_ROW_ADDR_W       = 9,
    parameter P_COL_ADDR_W       = 10,
    parameter P_SHIFT_W          = 5,
    parameter P_CONN_CNT_W       = 4,
    parameter P_MSG_ADDR_W       = 12
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    input  wire signed [P_Q_DATA_W-1:0]     s_axis_llr_tdata,
    input  wire                             s_axis_llr_tvalid,
    output wire                             s_axis_llr_tready,

    output wire                             m_axis_data_tdata,
    output wire                             m_axis_data_tvalid,
    input  wire                             m_axis_data_tready
);

    `include "ldpc_defines.vh"

    localparam P_H_NNZ_LOCAL = `P_H_NNZ;   // msg_buffer 深度 = H 的非零元数

    // 控制器 <-> 数据通路
    wire                            w_addr_en;
    wire [P_ROW_ADDR_W-1:0]         w_cur_row;
    wire [P_CONN_CNT_W-1:0]         w_cur_conn;
    wire                            w_phase_read;
    wire                            w_phase_wb;
    wire                            w_phase_synd;
    wire                            w_row_start;
    wire                            w_synd_clear;
    wire                            w_synd_eval;
    wire                            w_clear_req;
    wire                            w_decode_done;
    wire                            w_busy;

    wire [P_COL_ADDR_W-1:0]         w_h_col_addr;
    wire [P_SHIFT_W-1:0]            w_h_shift;
    wire [P_CONN_CNT_W-1:0]         w_h_conn_count;
    wire [P_MSG_ADDR_W-1:0]         w_h_msg_addr;
    wire                            w_h_valid;

    wire signed [P_Q_DATA_W-1:0]    w_llr_rd_data;
    wire signed [P_LR_W-1:0]        w_msg_rd_data;

    wire signed [P_LR_W-1:0]        w_cn_lr;
    wire signed [P_LQ_W-1:0]        w_cn_lq;
    wire                            w_cn_wb_valid;

    wire w_out_active, w_llr_loaded, w_load_wr_en;
    wire [P_LLR_ADDR_W-1:0] w_load_wr_addr, w_out_addr;
    wire signed [P_Q_DATA_W-1:0] w_load_wr_data;

    // 遍历相位的 j / valid 延迟链: 地址 2 拍 + 存储器 1 拍 = 数据晚 3 拍
    reg [P_CONN_CNT_W-1:0]  r_conn_d1, r_conn_d2, r_conn_d3;
    reg                     r_rd_v_d1, r_rd_v_d2, r_rd_v_d3;
    reg                     r_sd_v_d1, r_sd_v_d2, r_sd_v_d3;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_conn_d1 <= {P_CONN_CNT_W{1'b0}};
            r_conn_d2 <= {P_CONN_CNT_W{1'b0}};
            r_conn_d3 <= {P_CONN_CNT_W{1'b0}};
            r_rd_v_d1 <= 1'b0; r_rd_v_d2 <= 1'b0; r_rd_v_d3 <= 1'b0;
            r_sd_v_d1 <= 1'b0; r_sd_v_d2 <= 1'b0; r_sd_v_d3 <= 1'b0;
        end else begin
            r_conn_d1 <= w_cur_conn;   r_conn_d2 <= r_conn_d1;   r_conn_d3 <= r_conn_d2;
            r_rd_v_d1 <= w_phase_read; r_rd_v_d2 <= r_rd_v_d1;   r_rd_v_d3 <= r_rd_v_d2;
            r_sd_v_d1 <= w_phase_synd; r_sd_v_d2 <= r_sd_v_d1;   r_sd_v_d3 <= r_sd_v_d2;
        end
    end

    // L_q = LLR_total - L_r_old   (golden 此处不饱和, 位宽足够即精确一致)
    wire signed [P_LQ_W-1:0] w_lq;
    assign w_lq = $signed({{(P_LQ_W-P_Q_DATA_W){w_llr_rd_data[P_Q_DATA_W-1]}}, w_llr_rd_data})
                - $signed({{(P_LQ_W-P_LR_W){w_msg_rd_data[P_LR_W-1]}},        w_msg_rd_data});

    // VN 更新: LLR_new = sat(L_q + L_r) 到 [-512,511] (参考模型 L94-95 的钳位)。
    //  原实现 `assign w_llr_wr_data = w_lq + w_lr;` 是 10+10 赋 10, 直接回绕。
    localparam signed [P_LQ_W:0] P_SAT_HI =  (1 <<< (P_Q_DATA_W-1)) - 1;   //  511
    localparam signed [P_LQ_W:0] P_SAT_LO = -(1 <<< (P_Q_DATA_W-1));       // -512
    wire signed [P_LQ_W:0]          w_vn_sum;
    wire signed [P_Q_DATA_W-1:0]    w_vn_sat;
    assign w_vn_sum = $signed({w_cn_lq[P_LQ_W-1], w_cn_lq})
                    + $signed({{(P_LQ_W+1-P_LR_W){w_cn_lr[P_LR_W-1]}}, w_cn_lr});
    assign w_vn_sat = (w_vn_sum > P_SAT_HI) ? P_SAT_HI[P_Q_DATA_W-1:0] :
                      (w_vn_sum < P_SAT_LO) ? P_SAT_LO[P_Q_DATA_W-1:0] :
                                              w_vn_sum[P_Q_DATA_W-1:0];


    // syndrome 汇总 (逐行异或硬判决, 与 golden 的整迭代后判定同点)
    reg                             r_row_par;
    reg                             r_synd_fail;

    // 含当拍的行奇偶。折算(w_synd_eval)与末条边的异或可能落在同一拍, 若写成
    // 两个独立 if, 后者会覆盖前者丢掉该行最后一条边 —— 后果是 syndrome 恒不为
    // 零、早停永不触发、每帧跑满 20 次迭代, 而多数向量收敛后照样 0 失配, 只有
    // 个别向量在多余迭代里漂走, 极难定位。用组合值让两者同拍与否都成立。
    wire w_par_next;
    assign w_par_next = r_row_par ^ (r_sd_v_d3 ? w_llr_rd_data[P_Q_DATA_W-1] : 1'b0);

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_row_par   <= 1'b0;
            r_synd_fail <= 1'b0;
        end else if (w_synd_clear) begin
            r_synd_fail <= 1'b0;
            r_row_par   <= 1'b0;
        end else if (w_synd_eval) begin
            // 行扫描排空后折算本行奇偶, 并清空给下一行
            if (w_par_next) r_synd_fail <= 1'b1;
            r_row_par <= 1'b0;
        end else if (r_sd_v_d3) begin
            r_row_par <= w_par_next;
        end
    end

    // 存储器端口复用
    wire [P_LLR_ADDR_W-1:0]         w_llr_rd_addr;
    wire                            w_llr_wr_en;
    wire [P_LLR_ADDR_W-1:0]         w_llr_wr_addr;
    wire signed [P_Q_DATA_W-1:0]    w_llr_wr_data;

    // 读: 输出扫描期用回读地址, 其余用 h_matrix 列地址 (READ / SYND 相位)
    assign w_llr_rd_addr = w_out_active ? w_out_addr : w_h_col_addr[P_LLR_ADDR_W-1:0];

    // 写: 加载期写通道 LLR, 迭代期写 VN 更新结果
    assign w_llr_wr_en   = w_load_wr_en | w_cn_wb_valid;
    assign w_llr_wr_addr = w_load_wr_en ? w_load_wr_addr : w_h_col_addr[P_LLR_ADDR_W-1:0];
    assign w_llr_wr_data = w_load_wr_en ? w_load_wr_data : w_vn_sat;

    // msg_buffer 清零扫描: 参考模型每帧起始要求 L_r_old = 0, 而存储器本身没有
    // 清零通路 (BRAM 原语也不该有)。扫描逻辑放在顶层 —— 它是数据通路的事,
    // 控制器只发 o_clear_req 并等 i_clear_done。
    reg [P_MSG_ADDR_W:0]            r_clear_cnt;
    wire                            w_clear_done;
    wire                            w_clear_en;

    assign w_clear_done = (r_clear_cnt == P_H_NNZ_LOCAL);
    assign w_clear_en   = w_clear_req && !w_clear_done;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_clear_cnt <= {(P_MSG_ADDR_W+1){1'b0}};
        end else if (!w_clear_req) begin
            r_clear_cnt <= {(P_MSG_ADDR_W+1){1'b0}};
        end else if (!w_clear_done) begin
            r_clear_cnt <= r_clear_cnt + 1'b1;
        end
    end

    wire                            w_msg_wr_en;
    wire [P_MSG_ADDR_W-1:0]         w_msg_wr_addr;
    wire signed [P_LR_W-1:0]        w_msg_wr_data;

    assign w_msg_wr_en   = w_clear_en | w_cn_wb_valid;
    assign w_msg_wr_addr = w_clear_en ? r_clear_cnt[P_MSG_ADDR_W-1:0] : w_h_msg_addr;
    assign w_msg_wr_data = w_clear_en ? {P_LR_W{1'b0}} : w_cn_lr;

    // 子模块例化
    h_matrix_addr #(
        .P_MSG_ADDR_W   (P_MSG_ADDR_W)
    ) u_h_matrix_addr (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_cur_row      (w_cur_row),
        .i_cur_conn     (w_cur_conn),
        .i_en           (w_addr_en),
        .o_col_addr     (w_h_col_addr),
        .o_shift        (w_h_shift),
        .o_conn_count   (w_h_conn_count),
        .o_msg_addr     (w_h_msg_addr),
        .o_valid        (w_h_valid)
    );

    llr_buffer #(
        .P_DATA_W       (P_Q_DATA_W)
    ) u_llr_buffer (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_rd_addr      (w_llr_rd_addr),
        .o_rd_data      (w_llr_rd_data),
        .i_wr_en        (w_llr_wr_en),
        .i_wr_addr      (w_llr_wr_addr),
        .i_wr_data      (w_llr_wr_data)
    );

    msg_buffer #(
        .P_DATA_W       (P_LR_W),
        .P_ADDR_W       (P_MSG_ADDR_W)
    ) u_msg_buffer (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_rd_addr      (w_h_msg_addr),
        .o_rd_data      (w_msg_rd_data),
        .i_wr_en        (w_msg_wr_en),
        .i_wr_addr      (w_msg_wr_addr),
        .i_wr_data      (w_msg_wr_data)
    );

    cn_update #(
        .P_LQ_W         (P_LQ_W),
        .P_LR_W         (P_LR_W),
        .P_MAG_W        (P_MAG_W),
        .P_MAX_ROW_WT   (P_MAX_ROW_WT),
        .P_CONN_CNT_W   (P_CONN_CNT_W)
    ) u_cn_update (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_row_start    (w_row_start),
        .i_acc_en       (r_rd_v_d3),
        .i_lq           (w_lq),
        .i_conn_idx     (r_conn_d3),
        .i_wb_en        (w_phase_wb),
        .i_wb_idx       (w_cur_conn),
        .o_lr           (w_cn_lr),
        .o_lq           (w_cn_lq),
        .o_wb_valid     (w_cn_wb_valid)
    );

    ldpc_stream_io #(
        .P_N            (`P_N),
        .P_K            (`P_K),
        .P_Q_DATA_W     (P_Q_DATA_W),
        .P_LLR_ADDR_W   (P_LLR_ADDR_W)
    ) u_stream_io (
        .i_clk_sys          (i_clk_sys),
        .i_rst_sys          (i_rst_sys),
        .s_axis_llr_tdata   (s_axis_llr_tdata),
        .s_axis_llr_tvalid  (s_axis_llr_tvalid),
        .s_axis_llr_tready  (s_axis_llr_tready),
        .m_axis_data_tdata  (m_axis_data_tdata),
        .m_axis_data_tvalid (m_axis_data_tvalid),
        .m_axis_data_tready (m_axis_data_tready),
        .i_busy             (w_busy),
        .i_decode_done      (w_decode_done),
        .i_llr_rd_data      (w_llr_rd_data),
        .o_llr_loaded       (w_llr_loaded),
        .o_load_wr_en       (w_load_wr_en),
        .o_load_wr_addr     (w_load_wr_addr),
        .o_load_wr_data     (w_load_wr_data),
        .o_out_active       (w_out_active),
        .o_out_addr         (w_out_addr)
    );

    ldpc_controller #(
        .P_MSG_ADDR_W   (P_MSG_ADDR_W)
    ) u_controller (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_llr_loaded   (w_llr_loaded),
        .i_conn_count   (w_h_conn_count),
        .i_synd_fail    (r_synd_fail),
        .i_clear_done   (w_clear_done),
        .o_addr_en      (w_addr_en),
        .o_cur_row      (w_cur_row),
        .o_cur_conn     (w_cur_conn),
        .o_phase_read   (w_phase_read),
        .o_phase_wb     (w_phase_wb),
        .o_phase_synd   (w_phase_synd),
        .o_row_start    (w_row_start),
        .o_synd_clear   (w_synd_clear),
        .o_synd_eval    (w_synd_eval),
        .o_clear_req    (w_clear_req),
        .o_decode_done  (w_decode_done),
        .o_busy         (w_busy)
    );

endmodule
