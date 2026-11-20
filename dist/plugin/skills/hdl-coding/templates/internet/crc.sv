`timescale 1ns / 1ps
// template: crc
// version: 1.0.0
// domain: internet
// description: 参数化 CRC-32 (字节输入, 可配置初值/反射/移位方向/输出异或) — 外部资料改编
// requires: 命名未按 ri_/ro_ 规范, 复用前必须按 SKILL.md §1/§2 重写接口与命名
//---------------------------------------------------------------------------------------
//	Project Name	:
//	Module	Name	:crc32
//	Build	Date	:
//	Author	Name	:
//	Device	Num		:
//	Project	Intro	:
//
//	Tool	Versions:
//	Add		Comments:
//	
//---------------------------------------------------------------------------------------
//	Revision		By				Time				Updata	Discription
//	
//	Initial			Lih 			2025-12-03			CRC module for data[7:0] ,   
//                                                      crc[31:0]=1+x^1+x^2+x^4+x^5+x^7+x^8+x^10+x^11+x^12+x^16+x^22+x^23+x^26+x^32;
//---------------------------------------------------------------------------------------


module  crc32
#(
    parameter               INIT_CONDITION      =  1        ,
    parameter               REFLECT_BYTE        =  0        ,
    parameter               SHIFT_DIR           =  0        ,
    parameter               FINAL_XOR           =  0        
)
(
    input                   i_clk                           ,
    input                   i_rst                           ,

    input                   i_clear                         ,

    input   [7:0]           i_data_in                       ,
    input                   i_data_vld                      ,

    output  [31:0]          o_crc_out                       ,
    output                  o_crc_en              
);
//---------------------------------------------------------------------------------------
//
//						localparam	
//
//---------------------------------------------------------------------------------------

//---------------------------------------------------------------------------------------
//
//						Signal	Define	
//
//---------------------------------------------------------------------------------------
    wire    [31:0]          init_value                      ;
    wire    [31:0]          xor_value                       ;

    reg     [7:0]           dat_dly                         ;
    reg                     vld_dly                         ;
    reg     [31:0]          crc_reg                         ;
    wire    [31:0]          crc_pre                         ; 
    reg                     fall_catch                      ;
    reg                     crc_strobe                      ;
    reg     [31:0]          crc_out                         ;
//---------------------------------------------------------------------------------------
//
//						assignment	
//
//---------------------------------------------------------------------------------------
assign  o_crc_out           = crc_out                       ;
assign  o_crc_en            = crc_strobe                    ;
//
generate
    if (INIT_CONDITION == 1) begin
        assign  init_value  = 32'hFFFFFFFF                  ;
    end
    else begin
        assign  init_value  = 32'h00000000                  ;
    end
endgenerate
//
generate
    if (FINAL_XOR == 1) begin
        assign  xor_value   = 32'hFFFFFFFF                  ;
    end
    else begin
        assign  xor_value   = 32'h00000000                  ;
    end
endgenerate
//---------------------------------------------------------------------------------------
//
//						function
//
//---------------------------------------------------------------------------------------
generate//Input Reflect Select
    if(REFLECT_BYTE == 1)begin 
        always @(posedge i_clk ) begin
            dat_dly             <= {i_data_in[0],i_data_in[1],
                                    i_data_in[2],i_data_in[3],
                                    i_data_in[4],i_data_in[5],
                                    i_data_in[6],i_data_in[7]};
            vld_dly             <= i_data_vld               ;
        end
    end
    else    begin
        always @(posedge i_clk ) begin
            dat_dly             <= i_data_in                ;
            vld_dly             <= i_data_vld               ;
        end
    end
endgenerate
//
always @(posedge i_clk) begin
    if (i_rst) begin
        crc_reg                 <= init_value               ;
    end
    else    if (i_clear) begin
        crc_reg                 <= init_value               ;
    end
    else    if (vld_dly) begin
        crc_reg                 <= crc_pre                  ;
    end
    else begin
        crc_reg                 <= crc_reg                  ;
    end
end
//
always @(posedge i_clk) begin
    crc_out                     <= crc_reg ^ xor_value      ;
    crc_strobe                  <= fall_catch               ;
end
//
always @(posedge i_clk) begin
    fall_catch                  <= vld_dly & (!i_data_vld)  ;
end
//---------------------------------------------------------------------------------------
//
//						crc shift block
//
//---------------------------------------------------------------------------------------
generate
    if (SHIFT_DIR == 1) begin
        crc_32_right u_crc_32_right
        (
            .crcIn  (crc_reg    ),
            .data   (dat_dly    ),
            .crcOut (crc_pre    )
        );
    end
    else begin
        crc_32_left u_crc_32_left
        (
            .crcIn  (crc_reg    ),
            .data   (dat_dly    ),
            .crcOut (crc_pre    )
        );
    end
endgenerate
endmodule
//---------------------------------------------------------------------------------------
//
//						CRC 32 Standard
//
//---------------------------------------------------------------------------------------
// vim: ts=4 sw=4 expandtab

// THIS IS GENERATED VERILOG CODE.
// https://bues.ch/h/crcgen
// 
// This code is Public Domain.
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted.
// 
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
// SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
// RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
// NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
// USE OR PERFORMANCE OF THIS SOFTWARE.
// CRC polynomial coefficients: x^32 + x^26 + x^23 + x^22 + x^16 + x^12 + x^11 + x^10 + x^8 + x^7 + x^5 + x^4 + x^2 + x + 1
//                              0xEDB88320 (hex)
// CRC width:                   32 bits
// CRC shift direction:         right (little endian)
// Input word width:            8 bits

module crc_32_right 
(
    input [31:0] crcIn,
    input [7:0] data,
    output [31:0] crcOut
);
    assign crcOut[0] = crcIn[2] ^ crcIn[8] ^ data[2];
    assign crcOut[1] = crcIn[0] ^ crcIn[3] ^ crcIn[9] ^ data[0] ^ data[3];
    assign crcOut[2] = crcIn[0] ^ crcIn[1] ^ crcIn[4] ^ crcIn[10] ^ data[0] ^ data[1] ^ data[4];
    assign crcOut[3] = crcIn[1] ^ crcIn[2] ^ crcIn[5] ^ crcIn[11] ^ data[1] ^ data[2] ^ data[5];
    assign crcOut[4] = crcIn[0] ^ crcIn[2] ^ crcIn[3] ^ crcIn[6] ^ crcIn[12] ^ data[0] ^ data[2] ^ data[3] ^ data[6];
    assign crcOut[5] = crcIn[1] ^ crcIn[3] ^ crcIn[4] ^ crcIn[7] ^ crcIn[13] ^ data[1] ^ data[3] ^ data[4] ^ data[7];
    assign crcOut[6] = crcIn[4] ^ crcIn[5] ^ crcIn[14] ^ data[4] ^ data[5];
    assign crcOut[7] = crcIn[0] ^ crcIn[5] ^ crcIn[6] ^ crcIn[15] ^ data[0] ^ data[5] ^ data[6];
    assign crcOut[8] = crcIn[1] ^ crcIn[6] ^ crcIn[7] ^ crcIn[16] ^ data[1] ^ data[6] ^ data[7];
    assign crcOut[9] = crcIn[7] ^ crcIn[17] ^ data[7];
    assign crcOut[10] = crcIn[2] ^ crcIn[18] ^ data[2];
    assign crcOut[11] = crcIn[3] ^ crcIn[19] ^ data[3];
    assign crcOut[12] = crcIn[0] ^ crcIn[4] ^ crcIn[20] ^ data[0] ^ data[4];
    assign crcOut[13] = crcIn[0] ^ crcIn[1] ^ crcIn[5] ^ crcIn[21] ^ data[0] ^ data[1] ^ data[5];
    assign crcOut[14] = crcIn[1] ^ crcIn[2] ^ crcIn[6] ^ crcIn[22] ^ data[1] ^ data[2] ^ data[6];
    assign crcOut[15] = crcIn[2] ^ crcIn[3] ^ crcIn[7] ^ crcIn[23] ^ data[2] ^ data[3] ^ data[7];
    assign crcOut[16] = crcIn[0] ^ crcIn[2] ^ crcIn[3] ^ crcIn[4] ^ crcIn[24] ^ data[0] ^ data[2] ^ data[3] ^ data[4];
    assign crcOut[17] = crcIn[0] ^ crcIn[1] ^ crcIn[3] ^ crcIn[4] ^ crcIn[5] ^ crcIn[25] ^ data[0] ^ data[1] ^ data[3] ^ data[4] ^ data[5];
    assign crcOut[18] = crcIn[0] ^ crcIn[1] ^ crcIn[2] ^ crcIn[4] ^ crcIn[5] ^ crcIn[6] ^ crcIn[26] ^ data[0] ^ data[1] ^ data[2] ^ data[4] ^ data[5] ^ data[6];
    assign crcOut[19] = crcIn[1] ^ crcIn[2] ^ crcIn[3] ^ crcIn[5] ^ crcIn[6] ^ crcIn[7] ^ crcIn[27] ^ data[1] ^ data[2] ^ data[3] ^ data[5] ^ data[6] ^ data[7];
    assign crcOut[20] = crcIn[3] ^ crcIn[4] ^ crcIn[6] ^ crcIn[7] ^ crcIn[28] ^ data[3] ^ data[4] ^ data[6] ^ data[7];
    assign crcOut[21] = crcIn[2] ^ crcIn[4] ^ crcIn[5] ^ crcIn[7] ^ crcIn[29] ^ data[2] ^ data[4] ^ data[5] ^ data[7];
    assign crcOut[22] = crcIn[2] ^ crcIn[3] ^ crcIn[5] ^ crcIn[6] ^ crcIn[30] ^ data[2] ^ data[3] ^ data[5] ^ data[6];
    assign crcOut[23] = crcIn[3] ^ crcIn[4] ^ crcIn[6] ^ crcIn[7] ^ crcIn[31] ^ data[3] ^ data[4] ^ data[6] ^ data[7];
    assign crcOut[24] = crcIn[0] ^ crcIn[2] ^ crcIn[4] ^ crcIn[5] ^ crcIn[7] ^ data[0] ^ data[2] ^ data[4] ^ data[5] ^ data[7];
    assign crcOut[25] = crcIn[0] ^ crcIn[1] ^ crcIn[2] ^ crcIn[3] ^ crcIn[5] ^ crcIn[6] ^ data[0] ^ data[1] ^ data[2] ^ data[3] ^ data[5] ^ data[6];
    assign crcOut[26] = crcIn[0] ^ crcIn[1] ^ crcIn[2] ^ crcIn[3] ^ crcIn[4] ^ crcIn[6] ^ crcIn[7] ^ data[0] ^ data[1] ^ data[2] ^ data[3] ^ data[4] ^ data[6] ^ data[7];
    assign crcOut[27] = crcIn[1] ^ crcIn[3] ^ crcIn[4] ^ crcIn[5] ^ crcIn[7] ^ data[1] ^ data[3] ^ data[4] ^ data[5] ^ data[7];
    assign crcOut[28] = crcIn[0] ^ crcIn[4] ^ crcIn[5] ^ crcIn[6] ^ data[0] ^ data[4] ^ data[5] ^ data[6];
    assign crcOut[29] = crcIn[0] ^ crcIn[1] ^ crcIn[5] ^ crcIn[6] ^ crcIn[7] ^ data[0] ^ data[1] ^ data[5] ^ data[6] ^ data[7];
    assign crcOut[30] = crcIn[0] ^ crcIn[1] ^ crcIn[6] ^ crcIn[7] ^ data[0] ^ data[1] ^ data[6] ^ data[7];
    assign crcOut[31] = crcIn[1] ^ crcIn[7] ^ data[1] ^ data[7];
endmodule


//---------------------------------------------------------------------------------------
//
//						CRC 32 Standard	
//
//---------------------------------------------------------------------------------------
// vim: ts=4 sw=4 expandtab

// THIS IS GENERATED VERILOG CODE.
// https://bues.ch/h/crcgen
// 
// This code is Public Domain.
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted.
// 
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
// SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
// RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
// NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
// USE OR PERFORMANCE OF THIS SOFTWARE.

// CRC polynomial coefficients: x^32 + x^26 + x^23 + x^22 + x^16 + x^12 + x^11 + x^10 + x^8 + x^7 + x^5 + x^4 + x^2 + x + 1
//                              0x4C11DB7 (hex)
// CRC width:                   32 bits
// CRC shift direction:         left (big endian)
// Input word width:            8 bits

module crc_32_left 
(
    input [31:0] crcIn,
    input [7:0] data,
    output [31:0] crcOut
);
    assign crcOut[0] = crcIn[24] ^ crcIn[30] ^ data[0] ^ data[6];
    assign crcOut[1] = crcIn[24] ^ crcIn[25] ^ crcIn[30] ^ crcIn[31] ^ data[0] ^ data[1] ^ data[6] ^ data[7];
    assign crcOut[2] = crcIn[24] ^ crcIn[25] ^ crcIn[26] ^ crcIn[30] ^ crcIn[31] ^ data[0] ^ data[1] ^ data[2] ^ data[6] ^ data[7];
    assign crcOut[3] = crcIn[25] ^ crcIn[26] ^ crcIn[27] ^ crcIn[31] ^ data[1] ^ data[2] ^ data[3] ^ data[7];
    assign crcOut[4] = crcIn[24] ^ crcIn[26] ^ crcIn[27] ^ crcIn[28] ^ crcIn[30] ^ data[0] ^ data[2] ^ data[3] ^ data[4] ^ data[6];
    assign crcOut[5] = crcIn[24] ^ crcIn[25] ^ crcIn[27] ^ crcIn[28] ^ crcIn[29] ^ crcIn[30] ^ crcIn[31] ^ data[0] ^ data[1] ^ data[3] ^ data[4] ^ data[5] ^ data[6] ^ data[7];
    assign crcOut[6] = crcIn[25] ^ crcIn[26] ^ crcIn[28] ^ crcIn[29] ^ crcIn[30] ^ crcIn[31] ^ data[1] ^ data[2] ^ data[4] ^ data[5] ^ data[6] ^ data[7];
    assign crcOut[7] = crcIn[24] ^ crcIn[26] ^ crcIn[27] ^ crcIn[29] ^ crcIn[31] ^ data[0] ^ data[2] ^ data[3] ^ data[5] ^ data[7];
    assign crcOut[8] = crcIn[0] ^ crcIn[24] ^ crcIn[25] ^ crcIn[27] ^ crcIn[28] ^ data[0] ^ data[1] ^ data[3] ^ data[4];
    assign crcOut[9] = crcIn[1] ^ crcIn[25] ^ crcIn[26] ^ crcIn[28] ^ crcIn[29] ^ data[1] ^ data[2] ^ data[4] ^ data[5];
    assign crcOut[10] = crcIn[2] ^ crcIn[24] ^ crcIn[26] ^ crcIn[27] ^ crcIn[29] ^ data[0] ^ data[2] ^ data[3] ^ data[5];
    assign crcOut[11] = crcIn[3] ^ crcIn[24] ^ crcIn[25] ^ crcIn[27] ^ crcIn[28] ^ data[0] ^ data[1] ^ data[3] ^ data[4];
    assign crcOut[12] = crcIn[4] ^ crcIn[24] ^ crcIn[25] ^ crcIn[26] ^ crcIn[28] ^ crcIn[29] ^ crcIn[30] ^ data[0] ^ data[1] ^ data[2] ^ data[4] ^ data[5] ^ data[6];
    assign crcOut[13] = crcIn[5] ^ crcIn[25] ^ crcIn[26] ^ crcIn[27] ^ crcIn[29] ^ crcIn[30] ^ crcIn[31] ^ data[1] ^ data[2] ^ data[3] ^ data[5] ^ data[6] ^ data[7];
    assign crcOut[14] = crcIn[6] ^ crcIn[26] ^ crcIn[27] ^ crcIn[28] ^ crcIn[30] ^ crcIn[31] ^ data[2] ^ data[3] ^ data[4] ^ data[6] ^ data[7];
    assign crcOut[15] = crcIn[7] ^ crcIn[27] ^ crcIn[28] ^ crcIn[29] ^ crcIn[31] ^ data[3] ^ data[4] ^ data[5] ^ data[7];
    assign crcOut[16] = crcIn[8] ^ crcIn[24] ^ crcIn[28] ^ crcIn[29] ^ data[0] ^ data[4] ^ data[5];
    assign crcOut[17] = crcIn[9] ^ crcIn[25] ^ crcIn[29] ^ crcIn[30] ^ data[1] ^ data[5] ^ data[6];
    assign crcOut[18] = crcIn[10] ^ crcIn[26] ^ crcIn[30] ^ crcIn[31] ^ data[2] ^ data[6] ^ data[7];
    assign crcOut[19] = crcIn[11] ^ crcIn[27] ^ crcIn[31] ^ data[3] ^ data[7];
    assign crcOut[20] = crcIn[12] ^ crcIn[28] ^ data[4];
    assign crcOut[21] = crcIn[13] ^ crcIn[29] ^ data[5];
    assign crcOut[22] = crcIn[14] ^ crcIn[24] ^ data[0];
    assign crcOut[23] = crcIn[15] ^ crcIn[24] ^ crcIn[25] ^ crcIn[30] ^ data[0] ^ data[1] ^ data[6];
    assign crcOut[24] = crcIn[16] ^ crcIn[25] ^ crcIn[26] ^ crcIn[31] ^ data[1] ^ data[2] ^ data[7];
    assign crcOut[25] = crcIn[17] ^ crcIn[26] ^ crcIn[27] ^ data[2] ^ data[3];
    assign crcOut[26] = crcIn[18] ^ crcIn[24] ^ crcIn[27] ^ crcIn[28] ^ crcIn[30] ^ data[0] ^ data[3] ^ data[4] ^ data[6];
    assign crcOut[27] = crcIn[19] ^ crcIn[25] ^ crcIn[28] ^ crcIn[29] ^ crcIn[31] ^ data[1] ^ data[4] ^ data[5] ^ data[7];
    assign crcOut[28] = crcIn[20] ^ crcIn[26] ^ crcIn[29] ^ crcIn[30] ^ data[2] ^ data[5] ^ data[6];
    assign crcOut[29] = crcIn[21] ^ crcIn[27] ^ crcIn[30] ^ crcIn[31] ^ data[3] ^ data[6] ^ data[7];
    assign crcOut[30] = crcIn[22] ^ crcIn[28] ^ crcIn[31] ^ data[4] ^ data[7];
    assign crcOut[31] = crcIn[23] ^ crcIn[29] ^ data[5];
endmodule
//---------------------------------------------------------------------------------------
//
//						END
//
//---------------------------------------------------------------------------------------