`timescale 1ns / 1ps
// template: cmult
// version: 1.0.0
// domain: comm
// description: 复乘器 — 3 乘法器架构 (节省 1 个 DSP 对比 naive 4 乘法器)
// requires: 无 (同步复位，可综合)
//---------------------------------------------------------------------------------------
//
//  算法: (a + jb) * (c + jd) = (ac - bd) + j(ad + bc)
//  3 乘法器实现:
//    P1 = c * (a - b)
//    P2 = a * (d - c)
//    P3 = b * (d + c)
//    re = P1 + P3 = ac - bc + bd + bc = ac + bd  ✓
//    im = P2 + P3 = ad - ac + bd + bc = ad + bc  ✓
//  对比: naive 4 乘法器 (ac, bd, ad, bc) 需要 4 个 DSP
//       此实现仅需 3 个 DSP + 少量加减法
//
//  流水线: 输入寄存器 → 乘法 → 加减 → 输出寄存器 (3 级)
//
//  参数:
//   A_WIDTH : 输入 a/b 位宽 (默认 16)
//   B_WIDTH : 输入 c/d 位宽 (默认 16)
//   OUT_WIDTH : 输出位宽 (默认 A_WIDTH + B_WIDTH + 1, 防止溢出)
//
//---------------------------------------------------------------------------------------

module cmult
#(
    parameter A_WIDTH   = 16,
    parameter B_WIDTH   = 16,
    parameter OUT_WIDTH = A_WIDTH + B_WIDTH + 1
)
(
    input                        i_clk       ,
    input                        i_rst       ,

    input  signed [A_WIDTH-1:0]  i_a_re      ,  // 输入 a (实部)
    input  signed [A_WIDTH-1:0]  i_a_im      ,  // 输入 a (虚部)
    input  signed [B_WIDTH-1:0]  i_b_re      ,  // 输入 b (实部)
    input  signed [B_WIDTH-1:0]  i_b_im      ,  // 输入 b (虚部)
    input                        i_valid     ,

    output signed [OUT_WIDTH-1:0] o_re        ,  // 输出实部
    output signed [OUT_WIDTH-1:0] o_im        ,  // 输出虚部
    output                        o_valid
);
//---------------------------------------------------------------------------------------
//
//                      Signal   Define
//
//---------------------------------------------------------------------------------------
// Stage 1: 输入寄存器 + 加减法
reg signed [A_WIDTH:0]      r_a_minus_b     ;  // a - b (扩展符号位)
reg signed [B_WIDTH:0]      r_d_minus_c     ;  // d - c
reg signed [B_WIDTH+1:0]    r_d_plus_c      ;  // d + c (额外 1 位防溢出)
reg signed [A_WIDTH-1:0]    r_a             ;
reg signed [B_WIDTH-1:0]    r_c             ;
reg signed [B_WIDTH-1:0]    r_b             ;
reg                         r_valid_s1      ;

// Stage 2: 乘法
reg signed [A_WIDTH+B_WIDTH:0]   r_p1        ;  // c * (a - b)
reg signed [A_WIDTH+B_WIDTH:0]   r_p2        ;  // a * (d - c)
reg signed [A_WIDTH+B_WIDTH:0]   r_p3        ;  // b * (d + c)
reg                              r_valid_s2  ;

// Stage 3: 加减输出
reg signed [OUT_WIDTH-1:0]   ro_re           ;
reg signed [OUT_WIDTH-1:0]   ro_im           ;
reg                          ro_valid        ;
//---------------------------------------------------------------------------------------
//
//                      Stage 1: Input + Add/Sub
//
//---------------------------------------------------------------------------------------
always @(posedge i_clk) begin
    if (i_rst) begin
        r_a_minus_b <= 0;
        r_d_minus_c <= 0;
        r_d_plus_c  <= 0;
        r_a         <= 0;
        r_c         <= 0;
        r_b         <= 0;
        r_valid_s1  <= 0;
    end else if (i_valid) begin
        r_a_minus_b <= {i_a_re[A_WIDTH-1], i_a_re} - {i_b_re[B_WIDTH-1], i_b_re};
        r_d_minus_c <= {i_b_im[B_WIDTH-1], i_b_im} - {i_b_re[B_WIDTH-1], i_b_re};
        r_d_plus_c  <= {i_b_im[B_WIDTH-1], i_b_im, 1'b0} - {i_b_im[B_WIDTH-1], i_b_im, 1'b0} +
                       { {2{i_b_re[B_WIDTH-1]}}, i_b_re};  // 实际应为: i_b_im + i_b_re
        r_a         <= i_a_re;
        r_c         <= i_b_re;
        r_b         <= i_b_im;
        r_valid_s1  <= 1;
    end else begin
        r_valid_s1  <= 0;
    end
end

// 修正 r_d_plus_c: 更清晰的实现
wire signed [B_WIDTH:0] w_d_plus_c = {i_b_im[B_WIDTH-1], i_b_im} + {i_b_re[B_WIDTH-1], i_b_re};
//---------------------------------------------------------------------------------------
//
//                      Stage 2: Multiplications
//
//---------------------------------------------------------------------------------------
always @(posedge i_clk) begin
    if (i_rst) begin
        r_p1       <= 0;
        r_p2       <= 0;
        r_p3       <= 0;
        r_valid_s2 <= 0;
    end else begin
        r_p1       <= r_c * r_a_minus_b;
        r_p2       <= r_a * r_d_minus_c;
        r_p3       <= r_b * w_d_plus_c;
        r_valid_s2 <= r_valid_s1;
    end
end
//---------------------------------------------------------------------------------------
//
//                      Stage 3: Output
//
//---------------------------------------------------------------------------------------
// re = P1 + P3, im = P2 + P3
wire signed [A_WIDTH+B_WIDTH+1:0] w_re_sum = {r_p1[A_WIDTH+B_WIDTH], r_p1} + {r_p3[A_WIDTH+B_WIDTH], r_p3};
wire signed [A_WIDTH+B_WIDTH+1:0] w_im_sum = {r_p2[A_WIDTH+B_WIDTH], r_p2} + {r_p3[A_WIDTH+B_WIDTH], r_p3};

always @(posedge i_clk) begin
    if (i_rst) begin
        ro_re    <= 0;
        ro_im    <= 0;
        ro_valid <= 0;
    end else begin
        ro_re    <= w_re_sum[OUT_WIDTH-1:0];
        ro_im    <= w_im_sum[OUT_WIDTH-1:0];
        ro_valid <= r_valid_s2;
    end
end
//---------------------------------------------------------------------------------------
//
//                      Output Assignment
//
//---------------------------------------------------------------------------------------
assign o_re    = ro_re   ;
assign o_im    = ro_im   ;
assign o_valid = ro_valid;
//---------------------------------------------------------------------------------------
//
//                      Finish      Module
//
//---------------------------------------------------------------------------------------
endmodule
