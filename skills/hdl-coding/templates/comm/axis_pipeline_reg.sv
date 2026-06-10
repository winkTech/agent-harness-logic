`timescale 1ns / 1ps
// template: axis_pipeline_reg
// version: 1.0.0
// domain: comm
// description: AXI4-Stream 流水线寄存器 — 多级 pipeline 打断长延时路径
// requires: 无 (同步复位，可综合)
//---------------------------------------------------------------------------------------
//
//  特性:
//   - 参数化 DATA_WIDTH + DEPTH (流水线级数)
//   - 每级寄存器在 valid && ready 时更新，否则保持
//   - backpressure 从末级向前级逐级传导
//   - 解决 AXI4-Stream 链路上的时序收敛问题
//
//  参数:
//   DATA_WIDTH : 数据位宽 (默认 32)
//   DEPTH      : 流水线级数 (默认 2)
//
//---------------------------------------------------------------------------------------

module axis_pipeline_reg
#(
    parameter DATA_WIDTH = 32,
    parameter DEPTH      = 2
)
(
    input                        i_clk      ,
    input                        i_rst      ,

    input  [DATA_WIDTH-1:0]      i_tdata    ,
    input                        i_tvalid   ,
    output                       o_tready   ,

    output [DATA_WIDTH-1:0]      o_tdata    ,
    output                       o_tvalid   ,
    input                        i_tready
);
//---------------------------------------------------------------------------------------
//
//                      Signal   Define
//
//---------------------------------------------------------------------------------------
reg  [DATA_WIDTH-1:0]   r_tdata  [0:DEPTH-1];
reg                     r_tvalid [0:DEPTH-1];
wire                    w_advance;

integer i;
//---------------------------------------------------------------------------------------
//
//                      Pipeline Stages
//
//---------------------------------------------------------------------------------------
// 第一级: 从上游捕获
wire w_stage0_advance = !r_tvalid[0] || (r_tvalid[0] && w_advance);
wire w_stage0_update  = i_tvalid && (!r_tvalid[0] || w_advance);

always @(posedge i_clk) begin
    if (i_rst) begin
        r_tdata[0]  <= 0;
        r_tvalid[0] <= 0;
    end else if (w_stage0_update) begin
        r_tdata[0]  <= i_tdata;
        r_tvalid[0] <= 1;
    end else if (w_advance && !i_tvalid) begin
        r_tvalid[0] <= 0;
    end
end

assign o_tready = w_stage0_advance;
//---------------------------------------------------------------------------------------
//
//                      Internal Stages
//
//---------------------------------------------------------------------------------------
generate
    for (i = 1; i < DEPTH; i = i + 1) begin : gen_stage
        wire w_prev_advance = !r_tvalid[i] || (r_tvalid[i] && w_advance);
        wire w_update = r_tvalid[i-1] && w_prev_advance;

        always @(posedge i_clk) begin
            if (i_rst) begin
                r_tdata[i]  <= 0;
                r_tvalid[i] <= 0;
            end else if (w_update) begin
                r_tdata[i]  <= r_tdata[i-1];
                r_tvalid[i] <= 1;
            end else if (w_advance && !r_tvalid[i-1]) begin
                r_tvalid[i] <= 0;
            end
        end
    end
endgenerate
//---------------------------------------------------------------------------------------
//
//                      Last Stage Advance
//
//---------------------------------------------------------------------------------------
assign w_advance = i_tready || !r_tvalid[DEPTH-1];

assign o_tdata  = r_tdata[DEPTH-1];
assign o_tvalid = r_tvalid[DEPTH-1];
//---------------------------------------------------------------------------------------
//
//                      Finish      Module
//
//---------------------------------------------------------------------------------------
endmodule
