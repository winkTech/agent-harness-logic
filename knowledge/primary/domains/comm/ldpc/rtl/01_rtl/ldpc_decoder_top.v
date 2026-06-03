//-----------------------------------------------------------------
//                    LDPC Decoder Top Module
//-----------------------------------------------------------------
// 功能描述: 802.11n QC-LDPC Min-Sum 分层译码器顶层
//
// 架构: 串行流水线 (Row-Serial Pipelined)
//   - 每周期处理 1 个 CN→VN 连接
//   - 行内两遍: PASS1 累积 min → PASS2 计算 L_r
//   - 流水线: READ → L_Q → MIN → L_R → WRITE
//
// 参数: N=648, K=324, M=324, Z=27, Q(10,4)
//
// 接口: AXI4-Stream 简化版
//-----------------------------------------------------------------
// 主要逻辑:
//   1. 加载 LLR: 648 个 Q(10,4) 值写入 BRAM
//   2. 迭代译码: 逐行 Min-Sum 处理 (max 20 iterations)
//   3. 输出: 逐比特输出硬判决结果
//-----------------------------------------------------------------

module ldpc_decoder_top #(
    parameter P_MAX_ROW_WT       = 8,
    parameter P_Q_DATA_W         = 10,
    parameter P_LLR_ADDR_W       = 10,
    parameter P_ROW_ADDR_W       = 9,
    parameter P_COL_ADDR_W       = 10,
    parameter P_SHIFT_W          = 5,
    parameter P_CONN_CNT_W       = 4
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

    //-----------------------------------------------------------------
    // 内部连线
    //-----------------------------------------------------------------
    wire                            w_start_proc;
    wire [P_ROW_ADDR_W-1:0]         w_cur_row;
    wire [P_CONN_CNT_W-1:0]         w_cur_conn;
    wire [5:0]                      w_cur_iter;
    wire                            w_row_done;
    wire                            w_iter_done;
    wire                            w_decode_done;
    wire                            w_early_term;

    wire [P_COL_ADDR_W-1:0]         w_h_col_addr;
    wire [P_SHIFT_W-1:0]            w_h_shift;
    wire [P_CONN_CNT_W-1:0]         w_h_conn_count;
    wire                            w_h_valid;

    wire signed [P_Q_DATA_W-1:0]    w_llr_rd_data;
    wire signed [P_Q_DATA_W-1:0]    w_llr_wr_data;
    wire                            w_llr_wr_en;
    wire [P_LLR_ADDR_W-1:0]         w_llr_wr_addr;

    wire signed [P_Q_DATA_W-1:0]    w_msg_rd_data;
    wire signed [P_Q_DATA_W-1:0]    w_msg_wr_data;
    wire                            w_msg_wr_en;
    wire [P_LLR_ADDR_W-1:0]         w_msg_wr_addr;

    wire signed [P_Q_DATA_W-1:0]    w_lq;
    wire signed [P_Q_DATA_W-1:0]    w_lr;
    wire                            w_lr_valid;
    wire                            w_pipe_valid;

    //-----------------------------------------------------------------
    // 输入 LLR 加载控制
    //-----------------------------------------------------------------
    reg                             ri_llr_valid;
    reg signed [P_Q_DATA_W-1:0]     ri_llr_data;
    reg [P_LLR_ADDR_W-1:0]          r_llr_load_addr;
    reg                             r_llr_load_done;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_llr_valid    <= 1'b0;
            ri_llr_data     <= 'd0;
            r_llr_load_addr <= 'd0;
            r_llr_load_done <= 1'b0;
        end else begin
            ri_llr_valid <= s_axis_llr_tvalid;
            ri_llr_data  <= s_axis_llr_tdata;
            if (s_axis_llr_tvalid && s_axis_llr_tready) begin
                if (r_llr_load_addr == (`P_N - 1)) begin
                    r_llr_load_done <= 1'b1;
                end else begin
                    r_llr_load_addr <= r_llr_load_addr + 1'b1;
                end
            end
        end
    end

    assign s_axis_llr_tready = ~r_llr_load_done;

    //-----------------------------------------------------------------
    // 输出寄存器
    //-----------------------------------------------------------------
    reg                             ro_data;
    reg                             ro_valid;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_data  <= 1'b0;
            ro_valid <= 1'b0;
        end else begin
            if (w_decode_done) begin
                ro_data  <= w_llr_rd_data[P_Q_DATA_W-1];
                ro_valid <= 1'b1;
            end else if (m_axis_data_tready && ro_valid) begin
                ro_valid <= 1'b0;
            end
        end
    end

    assign m_axis_data_tdata  = ro_data;
    assign m_axis_data_tvalid = ro_valid;

    //-----------------------------------------------------------------
    // L_q 计算: L_q = LLR_total - L_r_old (组合逻辑)
    //-----------------------------------------------------------------
    assign w_lq         = w_llr_rd_data - w_msg_rd_data;
    assign w_pipe_valid = w_h_valid;

    //-----------------------------------------------------------------
    // 子模块例化
    //-----------------------------------------------------------------

    h_matrix_addr u_h_matrix_addr (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_cur_row      (w_cur_row),
        .i_cur_conn     (w_cur_conn),
        .i_en           (w_start_proc),
        .o_col_addr     (w_h_col_addr),
        .o_shift        (w_h_shift),
        .o_conn_count   (w_h_conn_count),
        .o_valid        (w_h_valid)
    );

    llr_buffer u_llr_buffer (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_rd_addr      (w_h_col_addr),
        .o_rd_data      (w_llr_rd_data),
        .i_wr_en        (w_llr_wr_en),
        .i_wr_addr      (w_llr_wr_addr),
        .i_wr_data      (w_llr_wr_data)
    );

    msg_buffer u_msg_buffer (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_rd_addr      ({w_cur_row, w_cur_conn}),
        .o_rd_data      (w_msg_rd_data),
        .i_wr_en        (w_msg_wr_en),
        .i_wr_addr      ({w_cur_row, w_cur_conn}),
        .i_wr_data      (w_msg_wr_data)
    );

    cn_update u_cn_update (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_lq           (w_lq),
        .i_valid        (w_pipe_valid),
        .i_conn_idx     (w_cur_conn),
        .i_row_start    (w_row_done),
        .i_conn_count   (w_h_conn_count),
        .o_lr           (w_lr),
        .o_lr_valid     (w_lr_valid)
    );

    // VN 更新 + 写回: LLR_new = sat(L_q + L_r)
    assign w_llr_wr_data = w_lq + w_lr;
    assign w_llr_wr_en   = w_lr_valid;
    assign w_llr_wr_addr = w_h_col_addr;

    assign w_msg_wr_data = w_lr;
    assign w_msg_wr_en   = w_lr_valid;
    assign w_msg_wr_addr = {w_cur_row, w_cur_conn};

    //-----------------------------------------------------------------
    // 早停检测
    //-----------------------------------------------------------------
    early_term u_early_term (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_hard_bit     (w_llr_rd_data[P_Q_DATA_W-1]),
        .i_valid        (w_pipe_valid),
        .i_row_start    (w_row_done),
        .i_row_done     (w_row_done),
        .o_early_term   (w_early_term)
    );

    ldpc_controller u_controller (
        .i_clk_sys      (i_clk_sys),
        .i_rst_sys      (i_rst_sys),
        .i_llr_loaded   (r_llr_load_done),
        .i_early_term   (w_early_term),
        .o_start_proc   (w_start_proc),
        .o_cur_row      (w_cur_row),
        .o_cur_conn     (w_cur_conn),
        .o_cur_iter     (w_cur_iter),
        .o_row_done     (w_row_done),
        .o_iter_done    (w_iter_done),
        .o_decode_done  (w_decode_done)
    );

endmodule
