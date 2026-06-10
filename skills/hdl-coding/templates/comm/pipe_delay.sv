`timescale 1ns / 1ps
// template: pipe_delay
// version: 1.0.0
// domain: comm
// description: 可变长流水线延迟 — 带 valid/ready 握手 (增强版 delay_sync)
// requires: 无 (同步复位，可综合)
//---------------------------------------------------------------------------------------
//
//  特性:
//   - 参数化 DATA_WIDTH + DELAY_CYCLES (延迟周期数)
//   - 相比现有 delay_sync.v: 增加了 valid/ready 握手，支持 backpressure
//   - valid 信号沿延迟链传播，与数据同步
//   - 输出数据与 golden model 逐周期可对比
//
//  参数:
//   DATA_WIDTH   : 数据位宽 (默认 32)
//   DELAY_CYCLES : 延迟周期数 (默认 1, 最小 1)
//
//---------------------------------------------------------------------------------------

module pipe_delay
#(
    parameter DATA_WIDTH   = 32,
    parameter DELAY_CYCLES = 1
)
(
    input                        i_clk       ,
    input                        i_rst       ,

    input  [DATA_WIDTH-1:0]      i_data      ,
    input                        i_valid     ,
    output                       o_ready     ,

    output [DATA_WIDTH-1:0]      o_data      ,
    output                       o_valid     ,
    input                        i_ready
);
//---------------------------------------------------------------------------------------
//
//                      Signal   Define
//
//---------------------------------------------------------------------------------------
reg [DATA_WIDTH-1:0]    r_data  [0:DELAY_CYCLES-1];
reg                     r_valid [0:DELAY_CYCLES-1];
integer                 i;

wire w_advance;  // 末级握手成功 = 整条链向前推进
//---------------------------------------------------------------------------------------
//
//                      Delay Line (逐级移位)
//
//---------------------------------------------------------------------------------------
// 第一级: 从上游捕获
wire w_stage0_advance = !r_valid[0] || (r_valid[0] && w_advance);

always @(posedge i_clk) begin
    if (i_rst) begin
        r_data[0]  <= 0;
        r_valid[0] <= 0;
    end else if (i_valid && w_stage0_advance) begin
        r_data[0]  <= i_data;
        r_valid[0] <= 1;
    end else if (w_advance && !i_valid) begin
        r_valid[0] <= 0;
    end
end

assign o_ready = w_stage0_advance;

// 中间级
generate
    for (i = 1; i < DELAY_CYCLES; i = i + 1) begin : gen_stage
        wire w_prev_advance = !r_valid[i] || (r_valid[i] && w_advance);

        always @(posedge i_clk) begin
            if (i_rst) begin
                r_data[i]  <= 0;
                r_valid[i] <= 0;
            end else if (r_valid[i-1] && w_prev_advance) begin
                r_data[i]  <= r_data[i-1];
                r_valid[i] <= 1;
            end else if (w_advance && !r_valid[i-1]) begin
                r_valid[i] <= 0;
            end
        end
    end
endgenerate
//---------------------------------------------------------------------------------------
//
//                      Output
//
//---------------------------------------------------------------------------------------
assign w_advance = i_ready || !r_valid[DELAY_CYCLES-1];

assign o_data  = r_data[DELAY_CYCLES-1];
assign o_valid = r_valid[DELAY_CYCLES-1];
//---------------------------------------------------------------------------------------
//
//                      Finish      Module
//
//---------------------------------------------------------------------------------------
endmodule
