// ============================================================================
// OFDM Transmitter Top
// 功能: OFDM 发射机顶层模块
//       输入比特流 → 调制映射 → 导频插入 → IFFT → 加CP → 输出
// 定点: 16bit, Q2.14(频域) / Q3.13(时域)
// 接口: AXI4-Stream
// ============================================================================

`timescale 1ns / 1ps

module ofdm_tx_top #(
    parameter FFT_LEN     = 64,
    parameter CP_LEN      = 16,
    parameter DATA_WIDTH  = 16,
    parameter MOD_TYPE    = 2     // 0:BPSK, 1:QPSK, 2:16QAM, 3:64QAM
)(
    input  wire                  clk,
    input  wire                  rst_n,

    // 数据输入 (AXI4-Stream Slave)
    input  wire [5:0]            s_axis_tdata,   // 最大6bit(64QAM)
    input  wire                  s_axis_tvalid,
    output wire                  s_axis_tready,
    input  wire                  s_axis_tlast,

    // 数据输出 (AXI4-Stream Master)
    output wire [DATA_WIDTH-1:0] m_axis_tdata,   // {Q[15:0], I[15:0]}
    output wire                  m_axis_tvalid,
    input  wire                  m_axis_tready,
    output wire                  m_axis_tlast,

    // 配置接口 (AXI4-Lite)
    input  wire [31:0]           cfg_fft_len,
    input  wire [15:0]           cfg_cp_len,
    input  wire [3:0]            cfg_mod_type
);

    // ========================================================================
    // Internal connections
    // ========================================================================

    // Mod Mapper -> Pilot Insert
    wire [15:0]  mod_i;       // Q2.14
    wire [15:0]  mod_q;       // Q2.14
    wire         mod_valid;
    wire         mod_ready;
    wire         mod_last;

    // Pilot Insert -> IFFT (AXI4-Stream)
    wire [15:0]  ifft_in_i;   // Q2.14
    wire [15:0]  ifft_in_q;   // Q2.14
    wire         ifft_in_valid;
    wire         ifft_in_ready;

    // IFFT -> CP Insert (AXI4-Stream)
    wire [15:0]  ifft_out_i;  // Q3.13
    wire [15:0]  ifft_out_q;  // Q3.13
    wire         ifft_out_valid;
    wire         ifft_out_ready;
    wire         ifft_out_last;

    // ========================================================================
    // Stage 1: Mod Mapper
    // ========================================================================
    mod_mapper #(
        .MOD_TYPE (MOD_TYPE)
    ) u_mod_mapper (
        .clk           (clk),
        .rst_n         (rst_n),
        .s_axis_tdata  (s_axis_tdata),
        .s_axis_tvalid (s_axis_tvalid),
        .s_axis_tready (s_axis_tready),
        .s_axis_tlast  (s_axis_tlast),
        .m_axis_i      (mod_i),
        .m_axis_q      (mod_q),
        .m_axis_tvalid (mod_valid),
        .m_axis_tready (mod_ready),
        .m_axis_tlast  (mod_last)
    );

    // ========================================================================
    // Stage 2: Pilot Insert + Subcarrier Mapping
    // ========================================================================
    pilot_insert #(
        .FFT_LEN    (FFT_LEN),
        .DATA_WIDTH (DATA_WIDTH)
    ) u_pilot_insert (
        .clk           (clk),
        .rst_n         (rst_n),
        .s_axis_i      (mod_i),
        .s_axis_q      (mod_q),
        .s_axis_tvalid (mod_valid),
        .s_axis_tready (mod_ready),
        .s_axis_tlast  (mod_last),
        .m_axis_i      (ifft_in_i),
        .m_axis_q      (ifft_in_q),
        .m_axis_tvalid (ifft_in_valid),
        .m_axis_tready (ifft_in_ready)
    );

    // ========================================================================
    // Stage 3: IFFT (Xilinx FFT IP)
    // ========================================================================
    // Xilinx FFT IP Core, Pipelined Streaming
    // 输入: Q2.14, 输出: Q3.13 (BFP scaling)
    // 此处为IP实例化接口, 实际使用需生成FFT IP Core
    xfft_64 u_xfft (
        .aclk               (clk),
        .aresetn            (rst_n),
        .s_axis_config_tdata(16'h0001),     // FFT mode, scaling schedule
        .s_axis_config_tvalid(1'b1),
        .s_axis_config_tready(),
        .s_axis_data_tdata ({ifft_in_i, ifft_in_q}),
        .s_axis_data_tvalid(ifft_in_valid),
        .s_axis_data_tready(ifft_in_ready),
        .s_axis_data_tlast (1'b0),
        .m_axis_data_tdata ({ifft_out_i, ifft_out_q}),
        .m_axis_data_tvalid(ifft_out_valid),
        .m_axis_data_tready(ifft_out_ready),
        .m_axis_data_tlast (ifft_out_last),
        .event_frame_started(),
        .event_tlast_unexpected(),
        .event_tlast_missing(),
        .event_data_in_channel_halt(),
        .event_data_out_channel_halt()
    );

    // ========================================================================
    // Stage 4: CP Insert + Output
    // ========================================================================
    cp_insert #(
        .FFT_LEN    (FFT_LEN),
        .CP_LEN     (CP_LEN),
        .DATA_WIDTH (DATA_WIDTH)
    ) u_cp_insert (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axis_i       (ifft_out_i),
        .s_axis_q       (ifft_out_q),
        .s_axis_tvalid  (ifft_out_valid),
        .s_axis_tready  (ifft_out_ready),
        .s_axis_tlast   (ifft_out_last),
        .m_axis_tdata   (m_axis_tdata),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tlast   (m_axis_tlast)
    );

endmodule
