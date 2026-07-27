// ⛔ SUPERSEDED (2026-07-27): 修复前旧版。权威版本:
// engineering-assets/incubator/intake/ldpc_codec/ (bit-true 0 失配)。
// 禁止引用/复制/例化; 详见 ../_SUPERSEDED.md。仅作历史对照保留。
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
    input  wire                             i_iter_done,    // 迭代完成脉冲

    output wire                             o_early_term
);

    //-----------------------------------------------------------------
    // 行内 syndrome 累加 (XOR)
    //  每行开始清零，逐连接 XOR hard_bit
    //  r_row_synd = 0 → 校验满足
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
    // 行 done 脉冲检测 (防 i_row_start 与 i_row_done 同拍冲突)
    //-----------------------------------------------------------------
    reg                          r_row_done_pe;   // 脉冲展宽

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_row_done_pe <= 1'b0;
        end else begin
            r_row_done_pe <= i_row_done;
        end
    end

    wire w_row_done_pulse;
    assign w_row_done_pulse = i_row_done && !r_row_done_pe;

    //-----------------------------------------------------------------
    // 全局 syndrome 标记 (任意行 synd != 0 → 标记置位)
    //  在迭代开始时 (i_iter_done 下降沿后) 清零
    //  不在 i_row_start 清零，避免与 i_row_done 竞争
    //-----------------------------------------------------------------
    reg                          r_iter_active;
    reg                          r_any_synd;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_iter_active <= 1'b0;
            r_any_synd    <= 1'b0;
        end else begin
            // i_iter_done 脉冲逻辑
            if (i_iter_done) begin
                r_iter_active <= 1'b0;
            end else if (i_row_start) begin
                r_iter_active <= 1'b1;
            end

            // 全局 syndrome: 只在迭代活跃期累加
            if (i_iter_done) begin
                r_any_synd    <= 1'b0;  // 迭代结束清零（为下次迭代准备）
            end else if (w_row_done_pulse && r_row_synd) begin
                r_any_synd    <= 1'b1;  // 标记：至少一行校验失败
            end
        end
    end

    //-----------------------------------------------------------------
    // 早停输出: 在迭代边界产生
    //  r_iter_active=0 且 i_iter_done=1 时检查:
    //  r_any_synd=0 → 所有行校验通过 → 早停
    //-----------------------------------------------------------------
    reg                          ro_early_term;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_early_term <= 1'b0;
        end else begin
            ro_early_term <= i_iter_done && !r_any_synd;
        end
    end

    assign o_early_term = ro_early_term;

endmodule
