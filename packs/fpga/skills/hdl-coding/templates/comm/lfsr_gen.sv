`timescale 1ns / 1ps
// template: lfsr_gen
// version: 1.0.0
// domain: comm
// description: 参数化 LFSR 生成器 — Fibonacci 实现，支持任意多项式/位宽/种子
// requires: 无 (同步复位，可综合)
//---------------------------------------------------------------------------------------
//
//  特性:
//   - 参数化 WIDTH / POLY / SEED
//   - Fibonacci 实现 (多 XOR 反馈到 LSB)
//   - 每时钟周期输出一个伪随机数
//   - o_valid 指示输出有效 (初始化后始终有效)
//   - 典型应用: 扰码器、PRBS 测试序列、白噪声生成
//
//  参数:
//   WIDTH : LFSR 位宽 (默认 16)
//   POLY  : 本原多项式 (默认 16'hB400, 即 x^16 + x^14 + x^13 + x^11 + 1)
//   SEED  : 初始种子 (默认 16'hACE1, 全 0 为非法)
//
//  常用多项式 (不包含 x^0 项):
//   - 3:  3'h3   (x^3 + x^2 + 1)
//   - 7:  7'h41  (x^7 + x^6 + 1)
//   - 15: 15'h69  (x^15 + x^14 + 1)
//   - 16: 16'hB400 (x^16 + x^14 + x^13 + x^11 + 1)
//   - 23: 23'h420001 (x^23 + x^18 + 1)
//   - 31: 31'h40000004 (x^31 + x^28 + 1)
//
//---------------------------------------------------------------------------------------

module lfsr_gen
#(
    parameter WIDTH = 16,
    parameter POLY  = 16'hB400,
    parameter SEED  = 16'hACE1
)
(
    input                        i_clk       ,
    input                        i_rst       ,

    input                        i_valid     ,  // 使能: 每拍推进一次
    output reg [WIDTH-1:0]       o_data      ,
    output                       o_valid
);
//---------------------------------------------------------------------------------------
//
//                      Signal   Define
//
//---------------------------------------------------------------------------------------
reg  [WIDTH-1:0]    r_lfsr  ;
wire                w_feedback;
reg                 r_done  ;
integer             i;
//---------------------------------------------------------------------------------------
//
//                      LFSR Core
//
//---------------------------------------------------------------------------------------
// 反馈位: 从 POLY 高位 (x^WIDTH 项) 推导
assign w_feedback = ^(r_lfsr & POLY[WIDTH-2:0]);

always @(posedge i_clk) begin
    if (i_rst) begin
        r_lfsr <= SEED;
        r_done <= 0;
    end else if (i_valid) begin
        r_lfsr <= {r_lfsr[WIDTH-2:0], w_feedback};
        r_done <= 1;
    end else if (!i_valid) begin
        r_done <= r_done;  // 保持
    end
end
//---------------------------------------------------------------------------------------
//
//                      Output
//
//---------------------------------------------------------------------------------------
always @(posedge i_clk) begin
    if (i_rst) begin
        o_data <= 0;
    end else if (i_valid) begin
        o_data <= r_lfsr;
    end
end

assign o_valid = i_valid;
//---------------------------------------------------------------------------------------
//
//                      Finish      Module
//
//---------------------------------------------------------------------------------------
endmodule
