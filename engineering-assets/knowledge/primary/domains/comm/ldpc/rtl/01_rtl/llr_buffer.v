// ⛔ SUPERSEDED (2026-07-27): 修复前旧版。权威版本:
// engineering-assets/incubator/intake/ldpc_codec/ (bit-true 0 失配)。
// 禁止引用/复制/例化; 详见 ../_SUPERSEDED.md。仅作历史对照保留。
//-----------------------------------------------------------------
//                       LLR Buffer Module
//-----------------------------------------------------------------
// 功能描述: LLR_total 后验概率存储 (Simple Dual-Port BRAM)
//   深度 648, 位宽 10-bit signed (Q(10,4))
//   端口 A: 读 (组合逻辑), 端口 B: 写 (时序逻辑)
//-----------------------------------------------------------------

module llr_buffer #(
    parameter P_DEPTH           = 648,
    parameter P_DATA_W          = 10,
    parameter P_ADDR_W          = 10
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    // 读端口 A
    input  wire [P_ADDR_W-1:0]              i_rd_addr,
    output wire signed [P_DATA_W-1:0]       o_rd_data,

    // 写端口 B
    input  wire                             i_wr_en,
    input  wire [P_ADDR_W-1:0]              i_wr_addr,
    input  wire signed [P_DATA_W-1:0]       i_wr_data
);

    //-----------------------------------------------------------------
    // BRAM 存储 (read-first 模式)
    //-----------------------------------------------------------------
    (* ram_style = "block" *) reg signed [P_DATA_W-1:0] r_mem [0:P_DEPTH-1];

    // 读操作 (组合逻辑)
    assign o_rd_data = r_mem[i_rd_addr];

    // 写操作 (时序逻辑)
    always @(posedge i_clk_sys) begin
        if (i_wr_en) begin
            r_mem[i_wr_addr] <= i_wr_data;
        end
    end

endmodule
