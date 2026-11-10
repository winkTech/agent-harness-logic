//-----------------------------------------------------------------
//                     Message Buffer Module
//-----------------------------------------------------------------
// 功能描述: L_r_old 消息存储 (CN→VN 历史消息)
//   深度 P_H_NNZ=2376, 位宽 P_DATA_W=12 bit signed
//   地址 = row_base[row] + conn_idx   (由 h_matrix_addr.o_msg_addr 产生)
//
// 位宽依据: golden models/comm/ldpc/src/ldpc_decoder_ms_fixed.m 对 L_r 不做
//   饱和, 实测 10 组向量 80784 条边的范围是 [-210, 208] (measure_ranges.m),
//   12 bit signed (±2048) 留约 10 倍余量。原 10 bit 虽然对这批向量够用,
//   但与 L_q 共用 P_Q_DATA_W 会掩盖二者本就不同的动态范围。
//
// 读时序: **同步读** —— i_rd_addr 当拍锁存, o_rd_data 下一拍有效。
//   原实现 assign o_rd_data = r_mem[i_rd_addr] 是存储器组合直出, 违反红线2,
//   且导致 Vivado 无法用 BRAM (synth.log [Synth 8-6849] Infeasible attribute
//   ram_style = block ... trying to implement using LUTRAM), 538 个 LUT 被
//   当成分布式 RAM, 占掉 875 LUT 预算的 61%。
//
// 清零: 本模块不含清零 FSM。上电/换帧的清零由顶层在 INIT 相位借写口扫描
//   完成 (golden 每帧起始要求 L_r_old = 0)。存储器保持为纯存储原语。
//-----------------------------------------------------------------

module msg_buffer #(
    parameter P_H_NNZ            = 2376,
    parameter P_DATA_W           = 12,
    parameter P_ADDR_W           = 12
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    // 读端口 (同步读, 1 拍延迟)
    input  wire [P_ADDR_W-1:0]              i_rd_addr,
    output wire signed [P_DATA_W-1:0]       o_rd_data,

    // 写端口
    input  wire                             i_wr_en,
    input  wire [P_ADDR_W-1:0]              i_wr_addr,
    input  wire signed [P_DATA_W-1:0]       i_wr_data
);

    (* ram_style = "block" *) reg signed [P_DATA_W-1:0] r_mem [0:P_H_NNZ-1];

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
