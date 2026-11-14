`timescale 1ns / 1ps
// template: axis_slave
// version: 1.0.0
// domain: comm
// description: AXI4-Stream Slave — 参数化接收 FIFO，tready 生成逻辑
// requires: 无 (同步复位，可综合)
//---------------------------------------------------------------------------------------
//
//  特性:
//   - 参数化 DATA_WIDTH / ID_WIDTH / DEST_WIDTH / USER_WIDTH
//   - 内部 FIFO 缓冲接收数据，解耦下游处理逻辑
//   - tready 在 FIFO 非满时有效，满时拉低实现 backpressure
//   - 捕获 tvalid && tready 时的全部信道域 (tdata/tid/tdest/tuser/tlast)
//   - 同步复位 active-high i_rst
//
//  接口时序:
//   上游 → tdata/tvalid/tlast → [FIFO] → o_data/o_valid → 下游逻辑
//         ← tready                        ← o_ready
//
//  参数:
//   DATA_WIDTH : 数据位宽 (默认 32)
//   ID_WIDTH   : ID 域位宽 (默认 8)
//   DEST_WIDTH : DEST 域位宽 (默认 8)
//   USER_WIDTH : USER 域位宽 (默认 1)
//   FIFO_DEPTH : 内部 FIFO 深度 (默认 8)
//
//---------------------------------------------------------------------------------------

module axis_slave
#(
    parameter DATA_WIDTH = 32,
    parameter ID_WIDTH   = 8,
    parameter DEST_WIDTH = 8,
    parameter USER_WIDTH = 1,
    parameter FIFO_DEPTH = 8
)
(
    input                        i_clk       ,
    input                        i_rst       ,

    // AXI4-Stream Slave 接口 (上游 → 本模块)
    input  [DATA_WIDTH-1:0]      i_tdata     ,
    input  [ID_WIDTH-1:0]        i_tid       ,
    input  [DEST_WIDTH-1:0]      i_tdest     ,
    input  [USER_WIDTH-1:0]      i_tuser     ,
    input                        i_tlast     ,
    input                        i_tvalid    ,
    output                       o_tready    ,

    // 下游 (接收数据 → 用户逻辑)
    output [DATA_WIDTH-1:0]      o_data      ,
    output [ID_WIDTH-1:0]        o_id        ,
    output [DEST_WIDTH-1:0]      o_dest      ,
    output [USER_WIDTH-1:0]      o_user      ,
    output                       o_last      ,
    output                       o_valid     ,
    input                        i_ready
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

// 捕获寄存器 (在 tvalid && tready 时刻锁存)
reg  [DATA_WIDTH-1:0]           ri_tdata    ;
reg  [ID_WIDTH-1:0]             ri_tid      ;
reg  [DEST_WIDTH-1:0]           ri_tdest    ;
reg  [USER_WIDTH-1:0]           ri_tuser    ;
reg                             ri_tlast    ;

// 输出寄存器
reg  [DATA_WIDTH-1:0]           ro_data     ;
reg  [ID_WIDTH-1:0]             ro_id       ;
reg  [DEST_WIDTH-1:0]           ro_dest     ;
reg  [USER_WIDTH-1:0]           ro_user     ;
reg                             ro_last     ;
reg                             ro_valid    ;

// 内部信号
wire                            w_capture   ;
wire                            w_pop       ;
wire [DATA_WIDTH+ID_WIDTH+DEST_WIDTH+USER_WIDTH+1:0] w_fifo_in ;
wire [DATA_WIDTH+ID_WIDTH+DEST_WIDTH+USER_WIDTH+1:0] w_fifo_out;
//---------------------------------------------------------------------------------------
//
//                      FIFO Control
//
//---------------------------------------------------------------------------------------
assign fifo_cnt   = wr_ptr - rd_ptr;
assign fifo_full  = (fifo_cnt == FIFO_DEPTH);
assign fifo_empty = (fifo_cnt == 0);

// tready: FIFO 未满时接收数据
assign o_tready = !fifo_full;

// 捕获时刻: tvalid && tready (AXI4-Stream 握手规范)
assign w_capture = i_tvalid && o_tready;

assign w_fifo_in = {ri_tlast, ri_tuser, ri_tdest, ri_tid, ri_tdata};

// 写 FIFO: 在捕获时刻将数据写入
always @(posedge i_clk) begin
    if (w_capture) begin
        fifo[wr_ptr[$clog2(FIFO_DEPTH)-1:0]] <= w_fifo_in;
        wr_ptr <= wr_ptr + 1;
    end
    if (i_rst) begin
        wr_ptr <= 0;
    end
end

// 读 FIFO: 下游消费数据时弹出
assign w_pop = ro_valid && i_ready && !fifo_empty;

always @(posedge i_clk) begin
    if (i_rst) begin
        rd_ptr <= 0;
    end else if (w_pop) begin
        rd_ptr <= rd_ptr + 1;
    end
end

assign w_fifo_out = fifo[rd_ptr[$clog2(FIFO_DEPTH)-1:0]];
//---------------------------------------------------------------------------------------
//
//                      Capture Registers
//
//---------------------------------------------------------------------------------------
always @(posedge i_clk) begin
    if (i_rst) begin
        ri_tdata <= 0;
        ri_tid   <= 0;
        ri_tdest <= 0;
        ri_tuser <= 0;
        ri_tlast <= 0;
    end else if (w_capture) begin
        ri_tdata <= i_tdata;
        ri_tid   <= i_tid  ;
        ri_tdest <= i_tdest;
        ri_tuser <= i_tuser;
        ri_tlast <= i_tlast;
    end
end
//---------------------------------------------------------------------------------------
//
//                      Output Logic (下游接口)
//
//---------------------------------------------------------------------------------------
always @(posedge i_clk) begin
    if (i_rst) begin
        ro_data  <= 0;
        ro_id    <= 0;
        ro_dest  <= 0;
        ro_user  <= 0;
        ro_last  <= 0;
        ro_valid <= 0;
    end else if (w_pop || !ro_valid) begin
        if (!fifo_empty) begin
            {ro_last, ro_user, ro_dest, ro_id, ro_data} <= w_fifo_out;
            ro_valid <= 1;
        end else begin
            ro_valid <= 0;
        end
    end
    // 当 ro_valid && !i_ready: 保持输出 (backpressure 向上游传导)
end
//---------------------------------------------------------------------------------------
//
//                      Output Assignment
//
//---------------------------------------------------------------------------------------
assign o_data  = ro_data ;
assign o_id    = ro_id   ;
assign o_dest  = ro_dest ;
assign o_user  = ro_user ;
assign o_last  = ro_last ;
assign o_valid = ro_valid;
//---------------------------------------------------------------------------------------
//
//                      Finish      Module
//
//---------------------------------------------------------------------------------------
endmodule
