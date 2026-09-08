`timescale 1ns / 1ps
// template: axis_master
// version: 1.0.0
// domain: comm
// description: AXI4-Stream Master — 参数化 FIFO 缓冲，正确 backpressure 处理
// requires: 无 (同步复位，可综合)
//---------------------------------------------------------------------------------------
//
//  特性:
//   - 参数化 DATA_WIDTH / ID_WIDTH / DEST_WIDTH / USER_WIDTH
//   - 内部 FIFO 缓冲解耦源逻辑与 backpressure
//   - tvalid/tready/tlast 握手信号完全符合 AXI4-Stream 规范
//   - tvalid 在 tready 未就绪时保持数据不变（规范要求）
//   - 同步复位 active-high i_rst
//
//  接口时序:
//   s_axis_* → [FIFO] → tdata/tvalid/tlast → 下游
//                        ← tready
//
//  参数:
//   DATA_WIDTH : 数据位宽 (默认 32)
//   ID_WIDTH   : ID 域位宽 (默认 8)
//   DEST_WIDTH : DEST 域位宽 (默认 8)
//   USER_WIDTH : USER 域位宽 (默认 1)
//   FIFO_DEPTH : 内部 FIFO 深度 (默认 8)
//
//---------------------------------------------------------------------------------------

module axis_master
#(
    parameter DATA_WIDTH = 32,
    parameter ID_WIDTH   = 8,
    parameter DEST_WIDTH = 8,
    parameter USER_WIDTH = 1,
    parameter FIFO_DEPTH = 8
)
(
    input                      i_clk           ,
    input                      i_rst           ,

    // 上游 (源逻辑 → 本模块)
    input  [DATA_WIDTH-1:0]    i_data          ,
    input  [ID_WIDTH-1:0]      i_id            ,
    input  [DEST_WIDTH-1:0]    i_dest          ,
    input  [USER_WIDTH-1:0]    i_user          ,
    input                      i_last          ,
    input                      i_valid         ,
    output                     o_ready         ,

    // 下游 (AXI4-Stream Master 接口)
    output [DATA_WIDTH-1:0]    o_tdata         ,
    output [ID_WIDTH-1:0]      o_tid           ,
    output [DEST_WIDTH-1:0]    o_tdest         ,
    output [USER_WIDTH-1:0]    o_tuser         ,
    output                     o_tlast         ,
    output                     o_tvalid        ,
    input                      i_tready
);
//---------------------------------------------------------------------------------------
//
//                      Signal   Define
//
//---------------------------------------------------------------------------------------
// FIFO 控制
reg  [DATA_WIDTH+ID_WIDTH+DEST_WIDTH+USER_WIDTH+1:0]   fifo    [0:FIFO_DEPTH-1];
reg  [$clog2(FIFO_DEPTH):0]                             wr_ptr  ;
reg  [$clog2(FIFO_DEPTH):0]                             rd_ptr  ;
wire [$clog2(FIFO_DEPTH):0]                             fifo_cnt;
wire                                                      fifo_full ;
wire                                                      fifo_empty;

// 输出寄存器 (AXI4-Stream 规范要求 valid 数据在 ready 未就绪时保持稳定)
reg  [DATA_WIDTH-1:0]   ro_tdata    ;
reg  [ID_WIDTH-1:0]     ro_tid      ;
reg  [DEST_WIDTH-1:0]   ro_tdest    ;
reg  [USER_WIDTH-1:0]   ro_tuser    ;
reg                     ro_tlast    ;
reg                     ro_tvalid   ;

// 内部信号
wire                    w_push      ;
wire                    w_pop       ;
wire [DATA_WIDTH+ID_WIDTH+DEST_WIDTH+USER_WIDTH+1:0] w_fifo_out;
//---------------------------------------------------------------------------------------
//
//                      FIFO Control
//
//---------------------------------------------------------------------------------------
assign fifo_cnt   = wr_ptr - rd_ptr;
assign fifo_full  = (fifo_cnt == FIFO_DEPTH);
assign fifo_empty = (fifo_cnt == 0);

assign w_push = i_valid && !fifo_full;
assign o_ready = !fifo_full;

assign w_pop = ro_tvalid && i_tready && !fifo_empty;

always @(posedge i_clk) begin
    if (i_rst) begin
        wr_ptr <= 0;
        rd_ptr <= 0;
    end else begin
        if (w_push) wr_ptr <= wr_ptr + 1;
        if (w_pop)  rd_ptr <= rd_ptr + 1;
    end
end
//---------------------------------------------------------------------------------------
//
//                      FIFO Memory
//
//---------------------------------------------------------------------------------------
// {last, user, dest, id, data}
wire [DATA_WIDTH+ID_WIDTH+DEST_WIDTH+USER_WIDTH+1:0] w_fifo_in;
assign w_fifo_in = {i_last, i_user, i_dest, i_id, i_data};

always @(posedge i_clk) begin
    if (w_push) begin
        fifo[wr_ptr[$clog2(FIFO_DEPTH)-1:0]] <= w_fifo_in;
    end
end

assign w_fifo_out = fifo[rd_ptr[$clog2(FIFO_DEPTH)-1:0]];
//---------------------------------------------------------------------------------------
//
//                      Output Register (AXI4-Stream)
//
//---------------------------------------------------------------------------------------
// tdata/tid/tdest/tuser/tlast 在 tvalid 被确认但 tready 未就绪时必须保持稳定
// 当本次传输完成 (tvalid && tready) 或当前无有效数据时，更新输出
wire w_transfer_done = ro_tvalid && i_tready;

always @(posedge i_clk) begin
    if (i_rst) begin
        ro_tdata  <= 0;
        ro_tid    <= 0;
        ro_tdest  <= 0;
        ro_tuser  <= 0;
        ro_tlast  <= 0;
        ro_tvalid <= 0;
    end else if (w_transfer_done || !ro_tvalid) begin
        if (!fifo_empty) begin
            {ro_tlast, ro_tuser, ro_tdest, ro_tid, ro_tdata} <= w_fifo_out;
            ro_tvalid <= 1;
        end else begin
            ro_tvalid <= 0;
        end
    end
    // 当 ro_tvalid && !i_tready: 保持输出不变 (默认行为)
end
//---------------------------------------------------------------------------------------
//
//                      Output Assignment
//
//---------------------------------------------------------------------------------------
assign o_tdata  = ro_tdata ;
assign o_tid    = ro_tid   ;
assign o_tdest  = ro_tdest ;
assign o_tuser  = ro_tuser ;
assign o_tlast  = ro_tlast ;
assign o_tvalid = ro_tvalid;
//---------------------------------------------------------------------------------------
//
//                      Finish      Module
//
//---------------------------------------------------------------------------------------
endmodule
