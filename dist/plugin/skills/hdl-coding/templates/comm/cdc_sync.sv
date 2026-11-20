`timescale 1ns / 1ps
// template: cdc_sync
// version: 1.0.0
// domain: comm
// description: 多级 CDC 同步器 — 支持单/多比特跨时钟域传递
// requires: 无 (同步复位，可综合)
//---------------------------------------------------------------------------------------
//
//  特性:
//   - 参数化 DATA_WIDTH / STAGES (同步级数)
//   - DATA_WIDTH=1: 标准 2 级 (或 N 级) 同步器
//   - DATA_WIDTH>1: 握手协议 (req/ack) 确保多比特数据安全传递
//   - 握手协议: src 域拉 req → dst 域采样 → dst 域拉 ack → src 域释放
//   - 同步复位 (i_rst_src / i_rst_dst 分别复位各自时钟域)
//
//  参数:
//   DATA_WIDTH : 数据位宽 (默认 1; >1 时启用握手协议)
//   STAGES     : 同步器级数 (默认 2; 高频跨时钟建议 3)
//
//  注意:
//   - 使用前必须在顶层约束中声明两个时钟域的 ASYNC_REG 属性
//   - 握手协议会增加延迟，但保证多比特数据的完整性
//   - 对于 DATA_WIDTH=1, 延迟约为 (STAGES + 1) × dst_clk 周期
//   - 对于 DATA_WIDTH>1, 延迟约为 2 × (STAGES + 1) × dst_clk 周期
//
//---------------------------------------------------------------------------------------

module cdc_sync
#(
    parameter DATA_WIDTH = 1,
    parameter STAGES     = 2
)
(
    // 源时钟域 (Source)
    input                        i_clk_src   ,
    input                        i_rst_src   ,
    input  [DATA_WIDTH-1:0]      i_data_src  ,
    input                        i_valid_src ,

    // 目的时钟域 (Destination)
    input                        i_clk_dst   ,
    input                        i_rst_dst   ,
    output [DATA_WIDTH-1:0]      o_data_dst  ,
    output                       o_valid_dst
);
//---------------------------------------------------------------------------------------
//
//                      Signal   Define
//
//---------------------------------------------------------------------------------------
// 握手信号 (DATA_WIDTH > 1 时使用)
reg                     r_req_src    ;  // src 域请求 (源时钟)
reg                     r_ack_src    ;  // src 域看到 ack (源时钟)
wire                    w_ack_sync   ;  // ack 同步到 src 域

reg                     r_ack_dst    ;  // dst 域 ack (目的时钟)
wire                    w_req_sync   ;  // req 同步到 dst 域

reg  [DATA_WIDTH-1:0]   r_data_capt  ;  // dst 域捕获的数据

// 同步器链 (req 跨到 dst, ack 跨到 src)
reg  [STAGES-1:0]       r_sync_req   ;  // req → dst 同步链
reg  [STAGES-1:0]       r_sync_ack   ;  // ack → src 同步链

// 单比特数据同步
reg  [STAGES-1:0]       r_sync_data  ;
//---------------------------------------------------------------------------------------
//
//                      Single-bit Path (DATA_WIDTH = 1)
//
//---------------------------------------------------------------------------------------
generate
    if (DATA_WIDTH == 1) begin : gen_single

        // N 级同步器链
        always @(posedge i_clk_dst) begin
            if (i_rst_dst) begin
                r_sync_data <= 0;
            end else begin
                r_sync_data[0] <= i_data_src;
                r_sync_data[STAGES-1:1] <= r_sync_data[STAGES-2:0];
            end
        end

        assign o_data_dst  = r_sync_data[STAGES-1];
        assign o_valid_dst = 1;  // 单比特: 每周期有效 (延迟 STAGES 拍)
    end
//---------------------------------------------------------------------------------------
//
//                      Multi-bit Path (DATA_WIDTH > 1, 握手协议)
//
//---------------------------------------------------------------------------------------
    else begin : gen_multi

        // ── 源时钟域: req 生成 ──
        always @(posedge i_clk_src) begin
            if (i_rst_src) begin
                r_req_src <= 0;
                r_ack_src <= 0;
            end else begin
                r_ack_src <= w_ack_sync;
                // 有新数据且上一次握手已完成 → 发送新请求
                if (i_valid_src && (r_req_src == r_ack_src)) begin
                    r_req_src <= ~r_req_src;
                end
            end
        end

        // ── req 同步到目的时钟域 ──
        always @(posedge i_clk_dst) begin
            if (i_rst_dst) begin
                r_sync_req <= 0;
            end else begin
                r_sync_req[0] <= r_req_src;
                r_sync_req[STAGES-1:1] <= r_sync_req[STAGES-2:0];
            end
        end

        assign w_req_sync = r_sync_req[STAGES-1];

        // ── 目的时钟域: 捕获数据 + 响应 ack ──
        always @(posedge i_clk_dst) begin
            if (i_rst_dst) begin
                r_ack_dst   <= 0;
                r_data_capt <= 0;
            end else begin
                // req 翻转 → 有新数据
                if (w_req_sync != r_ack_dst) begin
                    r_data_capt <= i_data_src;  // 注意: i_data_src 需保持稳定
                    r_ack_dst   <= w_req_sync;
                end
            end
        end

        // ── ack 同步回源时钟域 ──
        always @(posedge i_clk_src) begin
            if (i_rst_src) begin
                r_sync_ack <= 0;
            end else begin
                r_sync_ack[0] <= r_ack_dst;
                r_sync_ack[STAGES-1:1] <= r_sync_ack[STAGES-2:0];
            end
        end

        assign w_ack_sync = r_sync_ack[STAGES-1];

        // ── 输出 ──
        assign o_data_dst  = r_data_capt;
        assign o_valid_dst = (w_req_sync != r_ack_dst) && !i_rst_dst;

    end
endgenerate
//---------------------------------------------------------------------------------------
//
//                      Finish      Module
//
//---------------------------------------------------------------------------------------
endmodule
