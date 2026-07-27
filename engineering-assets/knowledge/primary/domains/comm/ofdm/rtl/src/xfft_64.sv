// ============================================================================
// xfft_64 — Xilinx FFT IP 核行为模型
// 功能: 流水线 FFT, 64 点, 输入输出均为 AXI4-Stream
//       本文件为行为级模型, 用于 UVM 验证框架编译/运行
//
// 行为: 数据延迟 64+N 个时钟周期后透传 (模拟 FFT 处理延迟)
// TODO: 正式实现时替换为 Xilinx IP 生成的仿真模型
// ============================================================================

`timescale 1ns / 1ps

module xfft_64 (
    input  wire         aclk,
    input  wire         aresetn,

    // 配置 (简化: 仅使用 FFT 模式)
    input  wire [15:0]  s_axis_config_tdata,
    input  wire         s_axis_config_tvalid,
    output wire         s_axis_config_tready,

    // 数据输入 (packed: {I[15:0], Q[15:0]})
    input  wire [31:0]  s_axis_data_tdata,
    input  wire         s_axis_data_tvalid,
    output wire         s_axis_data_tready,
    input  wire         s_axis_data_tlast,

    // 数据输出 (packed: {I[15:0], Q[15:0]})
    output wire [31:0]  m_axis_data_tdata,
    output wire         m_axis_data_tvalid,
    input  wire         m_axis_data_tready,
    output wire         m_axis_data_tlast,

    // 事件
    output wire         event_frame_started,
    output wire         event_tlast_unexpected,
    output wire         event_tlast_missing,
    output wire         event_data_in_channel_halt,
    output wire         event_data_out_channel_halt
);

    // ========================================================================
    // 参数
    // ========================================================================
    // Xilinx FFT 流水线延迟 ≈ FFT_LEN / 4 + 若干时钟 (此处用 32 拍简化)
    localparam PIPE_DELAY = 32;

    // ========================================================================
    // 延迟线 (FIFO 行为)
    // ========================================================================
    logic [31:0]  delay_data   [$];
    logic         delay_valid  [$];
    logic         delay_last   [$];

    logic         ready_for_input;

    assign s_axis_config_tready = 1'b1;
    assign s_axis_data_tready   = (delay_data.size() < 256);  // 背压保护

    // event 信号 (简化: 不报告异常)
    assign event_frame_started         = s_axis_data_tvalid && s_axis_data_tready && s_axis_data_tlast;
    assign event_tlast_unexpected      = 1'b0;
    assign event_tlast_missing         = 1'b0;
    assign event_data_in_channel_halt  = 1'b0;
    assign event_data_out_channel_halt = 1'b0;

    // ========================================================================
    // 输入阶段: 按有效握手存入延迟线
    // ========================================================================
    always @(posedge aclk) begin
        if (s_axis_data_tvalid && s_axis_data_tready) begin
            delay_data.push_back(s_axis_data_tdata);
            delay_valid.push_back(1'b1);
            delay_last.push_back(s_axis_data_tlast);

            // 每 FFT_LEN 笔输入, 插入帧 sync
            // (简化: 透传 tlast)
        end
    end

    // ========================================================================
    // 输出阶段: 延迟 PIPE_DELAY 个周期后输出
    // ========================================================================
    logic [31:0]  r_out_data;
    logic         r_out_valid;
    logic         r_out_last;

    always @(posedge aclk) begin
        if (!aresetn) begin
            r_out_valid <= 1'b0;
        end else begin
            // 从延迟线中取出 (简化: 仅用 valid 标志模拟固定延迟)
            if (delay_valid.size() > 0 && (r_out_valid == 1'b0 || m_axis_data_tready)) begin
                r_out_data  <= delay_data[0];
                r_out_valid <= delay_valid[0];
                r_out_last  <= delay_last[0];
                void'(delay_data.pop_front());
                void'(delay_valid.pop_front());
                void'(delay_last.pop_front());
            end else if (m_axis_data_tready && r_out_valid) begin
                r_out_valid <= 1'b0;
            end
        end
    end

    assign m_axis_data_tdata  = r_out_data;
    assign m_axis_data_tvalid = r_out_valid;
    assign m_axis_data_tlast  = r_out_last;

endmodule
