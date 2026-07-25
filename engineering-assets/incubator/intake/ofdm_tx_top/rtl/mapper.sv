//-----------------------------------------------------------------
//                          Mod Mapper
//-----------------------------------------------------------------
// 功能描述: 比特流 → IQ 调制符号映射
//   支持 BPSK / QPSK / 16QAM / 64QAM
//   定点格式: Q2.14 (16-bit signed)
//   流水线: 3 级 (输入寄存 → 调制 → 输出寄存)
//-----------------------------------------------------------------
// 主要逻辑:
//   1. Stage1: 输入寄存 (data_d1/valid_d1/last_d1)
//   2. Stage2: 查表调制 → IQ 符号
//   3. Stage3: 输出寄存 (m_axis_tvalid/tlast)
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module mapper #(
    parameter int P_MOD_TYPE = 2
)(
    input  wire         i_clk_sys,
    input  wire         i_rst_sys,

    input  wire [5:0]   s_axis_tdata,
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    input  wire         s_axis_tlast,

    output wire [15:0]  m_axis_i,
    output wire [15:0]  m_axis_q,
    output wire         m_axis_tvalid,
    input  wire         m_axis_tready,
    output wire         m_axis_tlast
);

    //-----------------------------------------------------------------
    // Q2.14 星座点常量 (1.0 = 16'h4000)
    //-----------------------------------------------------------------
    localparam BPSK_POS       = 16'h4000;
    localparam BPSK_NEG       = 16'hC000;
    localparam QPSK_POS       = 16'h2D41;
    localparam QPSK_NEG       = 16'hD2BF;
    localparam QAM16_AMP1     = 16'h1440;
    localparam QAM16_AMP3     = 16'h3CC0;
    localparam QAM16_AMP1_NEG = 16'hEBC0;
    localparam QAM16_AMP3_NEG = 16'hC340;

    //-----------------------------------------------------------------
    // 流水线寄存器 (r_ 前缀)
    //-----------------------------------------------------------------
    reg [5:0]  r_data_d1;
    reg        r_valid_d1;
    reg        r_last_d1;

    reg [15:0] r_i_d2;
    reg [15:0] r_q_d2;
    reg        r_valid_d2;
    reg        r_last_d2;

    reg        ro_valid;
    reg        ro_last;

    wire       w_ready;

    assign s_axis_tready = w_ready;
    assign w_ready       = !r_valid_d2 || m_axis_tready;

    //-----------------------------------------------------------------
    // Stage 1: 输入寄存器 (同步复位)
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_data_d1  <= 6'd0;
            r_valid_d1 <= 1'b0;
            r_last_d1  <= 1'b0;
        end else if (s_axis_tvalid && w_ready) begin
            r_data_d1  <= s_axis_tdata;
            r_valid_d1 <= 1'b1;
            r_last_d1  <= s_axis_tlast;
        end else if (m_axis_tready) begin
            r_valid_d1 <= 1'b0;
        end
    end

    //-----------------------------------------------------------------
    // Stage 2: 调制映射 (组合逻辑函数调用)
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_i_d2     <= 16'd0;
            r_q_d2     <= 16'd0;
            r_valid_d2 <= 1'b0;
            r_last_d2  <= 1'b0;
        end else if (r_valid_d1) begin
            {r_i_d2, r_q_d2} = modulate(r_data_d1);
            r_valid_d2        <= 1'b1;
            r_last_d2         <= r_last_d1;
        end else begin
            r_valid_d2 <= 1'b0;
        end
    end

    //-----------------------------------------------------------------
    // Stage 3: 输出寄存器
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_valid <= 1'b0;
            ro_last  <= 1'b0;
        end else begin
            ro_valid <= r_valid_d2 && m_axis_tready;
            ro_last  <= r_last_d2;
        end
    end

    assign m_axis_i      = r_i_d2;
    assign m_axis_q      = r_q_d2;
    assign m_axis_tvalid = ro_valid;
    assign m_axis_tlast  = ro_last;

    //-----------------------------------------------------------------
    // 调制函数
    //-----------------------------------------------------------------
    function [31:0] modulate(input [5:0] bits);
        reg [15:0] i_out, q_out;
        begin
            case (P_MOD_TYPE)
                3'd0: begin
                    i_out = bits[0] ? BPSK_POS : BPSK_NEG;
                    q_out = 16'd0;
                end
                3'd1: begin
                    i_out = bits[0] ? QPSK_POS : QPSK_NEG;
                    q_out = bits[1] ? QPSK_POS : QPSK_NEG;
                end
                3'd2: begin
                    qam16_map(bits[1:0], bits[3:2], i_out, q_out);
                end
                3'd3: begin
                    qam64_map(bits[2:0], bits[5:4], i_out, q_out);
                end
                default: begin
                    i_out = 16'd0;
                    q_out = 16'd0;
                end
            endcase
            modulate = {i_out, q_out};
        end
    endfunction

    //-----------------------------------------------------------------
    // 16QAM Gray 映射
    //-----------------------------------------------------------------
    function automatic void qam16_map(
        input [1:0] i_bits, q_bits,
        output reg [15:0] i_val, q_val
    );
        case (i_bits)
            2'b00: i_val = QAM16_AMP3_NEG;
            2'b01: i_val = QAM16_AMP1_NEG;
            2'b11: i_val = QAM16_AMP1;
            2'b10: i_val = QAM16_AMP3;
            default: i_val = 16'd0;
        endcase
        case (q_bits)
            2'b00: q_val = QAM16_AMP3_NEG;
            2'b01: q_val = QAM16_AMP1_NEG;
            2'b11: q_val = QAM16_AMP1;
            2'b10: q_val = QAM16_AMP3;
            default: q_val = 16'd0;
        endcase
    endfunction

    //-----------------------------------------------------------------
    // 64QAM Gray 映射
    //-----------------------------------------------------------------
    function automatic void qam64_map(
        input [2:0] i_bits, q_bits,
        output reg [15:0] i_val, q_val
    );
        i_val = 16'd0;
        q_val = 16'd0;
    endfunction

endmodule
