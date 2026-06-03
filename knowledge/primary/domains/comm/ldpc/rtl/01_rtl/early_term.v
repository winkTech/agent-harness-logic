//-----------------------------------------------------------------
//                    Early Termination Module
//-----------------------------------------------------------------
// 功能描述: Syndrome 早停检测
//   对每行连接, 累加 hard_bit 的 XOR 得到 syndrome 位
//   若某行 syndrome != 0, 标记为非零
//   所有行 synd == 0 → 早停
//-----------------------------------------------------------------

module early_term #(
    parameter P_M                = 324
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    input  wire                             i_hard_bit,
    input  wire                             i_valid,
    input  wire                             i_row_start,
    input  wire                             i_row_done,

    output wire                             o_early_term
);

    //-----------------------------------------------------------------
    // 行内 syndrome 累加 (XOR)
    //-----------------------------------------------------------------
    reg                          r_row_synd;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_row_synd <= 1'b0;
        end else begin
            if (i_row_start) begin
                r_row_synd <= 1'b0;
            end else if (i_valid) begin
                r_row_synd <= r_row_synd ^ i_hard_bit;
            end
        end
    end

    //-----------------------------------------------------------------
    // 全局 syndrome 标记 (任意行 synd != 0 → 标记置位)
    //-----------------------------------------------------------------
    reg                          r_any_synd;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_any_synd <= 1'b0;
        end else begin
            if (i_row_start) begin
                r_any_synd <= 1'b0;
            end else if (i_row_done && r_row_synd) begin
                r_any_synd <= 1'b1;
            end
        end
    end

    //-----------------------------------------------------------------
    // 早停输出 (寄存器驱动)
    //-----------------------------------------------------------------
    reg                          ro_early_term;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_early_term <= 1'b0;
        end else begin
            ro_early_term <= !r_any_synd && i_row_done;
        end
    end

    assign o_early_term = ro_early_term;

endmodule
