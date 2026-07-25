//-----------------------------------------------------------------
//                     Message Buffer Module
//-----------------------------------------------------------------
// 功能描述: L_r_old 消息存储 (CN→VN 历史消息)
//   深度 P_H_NNZ=2376, 位宽 10-bit signed (Q(10,4))
//   存储格式: 按行排列, 每行最多 P_MAX_ROW_WT=8 个消息
//   地址 = row_base[row] + conn_idx
//-----------------------------------------------------------------

module msg_buffer #(
    parameter P_H_NNZ            = 2376,
    parameter P_MAX_ROW_WT       = 8,
    parameter P_DATA_W           = 10,
    parameter P_ADDR_W           = 12
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    // 读端口
    input  wire [P_ADDR_W-1:0]              i_rd_addr,
    output wire signed [P_DATA_W-1:0]       o_rd_data,

    // 写端口
    input  wire                             i_wr_en,
    input  wire [P_ADDR_W-1:0]              i_wr_addr,
    input  wire signed [P_DATA_W-1:0]       i_wr_data
);

    //-----------------------------------------------------------------
    // BRAM 存储
    //-----------------------------------------------------------------
    (* ram_style = "block" *) reg signed [P_DATA_W-1:0] r_mem [0:P_H_NNZ-1];

    assign o_rd_data = r_mem[i_rd_addr];

    always @(posedge i_clk_sys) begin
        if (i_wr_en) begin
            r_mem[i_wr_addr] <= i_wr_data;
        end
    end

endmodule
