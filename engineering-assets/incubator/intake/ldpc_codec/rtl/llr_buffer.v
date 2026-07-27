//-----------------------------------------------------------------
//                       LLR Buffer Module
//-----------------------------------------------------------------
// 功能描述: LLR_total 后验概率存储 (Simple Dual-Port BRAM)
//   深度 648, 位宽 10-bit signed (Q(10,4))
//
// 位宽依据: golden 对 VN 更新做对称饱和到 [-512, 511]
//   (ldpc_decoder_ms_fixed.m 的 MAX_INT/MIN_INT, internal_bits=10;
//    设计规格 knowledge/.../stage3_fixed_point_report.md §6 同口径),
//   实测 10 组向量的 LLR_total 恰为 [-512, 511], 10 bit signed 精确吻合。
//
// 读时序: **同步读** —— i_rd_addr 当拍锁存, o_rd_data 下一拍有效。
//   原实现是存储器组合直出 (红线2 违规) 且逼 Vivado 退化到 LUTRAM。
//-----------------------------------------------------------------

module llr_buffer #(
    parameter P_DEPTH           = 648,
    parameter P_DATA_W          = 10,
    parameter P_ADDR_W          = 10
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    // 读端口 A (同步读, 1 拍延迟)
    input  wire [P_ADDR_W-1:0]              i_rd_addr,
    output wire signed [P_DATA_W-1:0]       o_rd_data,

    // 写端口 B
    input  wire                             i_wr_en,
    input  wire [P_ADDR_W-1:0]              i_wr_addr,
    input  wire signed [P_DATA_W-1:0]       i_wr_data
);

    (* ram_style = "block" *) reg signed [P_DATA_W-1:0] r_mem [0:P_DEPTH-1];

    reg signed [P_DATA_W-1:0] ro_rd_data;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_rd_data <= {P_DATA_W{1'b0}};
        end else begin
            ro_rd_data <= r_mem[i_rd_addr];
        end
        if (i_wr_en) begin
            r_mem[i_wr_addr] <= i_wr_data;
        end
    end

    assign o_rd_data = ro_rd_data;

endmodule
