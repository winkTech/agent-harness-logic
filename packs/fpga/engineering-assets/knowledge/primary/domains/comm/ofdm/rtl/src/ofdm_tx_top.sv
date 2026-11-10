// ============================================================================
// ofdm_tx_top — OFDM 发射机顶层
// 功能: 输入比特流 → 调制映射 → 导频/子载波映射 → 64 点 IFFT → 加 CP → 输出
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (比特流, 最大 6bit/符号);
//       m_axis_tdata = {I[15:0], Q[15:0]} 打包时域样点; i_cfg_* 运行时配置
// 主要逻辑: mod_mapper → pilot_insert → xfft_64 → cp_insert 四级串联
// 定点: 16bit, Q2.14(频域) / Q3.13(时域)
// 接口: AXI4-Stream
// 复位: 同步高有效, 统一下发给各级子模块
//
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   (1) 端口 clk/rst_n -> i_clk/i_rst, 复位改同步高有效;
//   (2) cfg_* -> i_cfg_* (非标准总线, 需前缀);
//   (3) **位宽修正 (SKILL.md §5)**: m_axis_tdata 由 [DATA_WIDTH-1:0]=16 位
//       改为 [DATA_WIDTH*2-1:0]=32 位 —— 原声明与 {I,Q} 打包语义矛盾, I 路被
//       静默截断。cp_insert 与 tb 已同步更新。
//
// !! 遗留缺陷 (承自原始代码, 本次**未改**) !!
//   [F1] i_cfg_fft_len / i_cfg_cp_len / i_cfg_mod_type 三个配置端口
//        **在本模块内完全没有被使用** —— 运行时配置未实现, FFT 长度/CP 长度/
//        调制方式实际由 parameter 静态决定。综合时会被优化掉并报未连接。
//   [F2] xfft_64 是行为级透传占位模型, 不做真实 IFFT (见该文件头), 因此顶层
//        输出不可能与 golden 的 expected_tx.bin 对齐, fidelity 只能是 pending。
//   [F3] 下游 cp_insert 的乒乓/符号计数缺陷 (见 cp_insert.sv [F1][F2][F3])
//        使本链当前无法产出正确的 CP 符号流。
// ============================================================================

`timescale 1ns / 1ps

module ofdm_tx_top #(
    parameter FFT_LEN     = 64,
    parameter CP_LEN      = 16,
    parameter DATA_WIDTH  = 16,
    parameter MOD_TYPE    = 2     // 0:BPSK, 1:QPSK, 2:16QAM, 3:64QAM
)(
    input  wire                    i_clk,
    input  wire                    i_rst,        // 同步复位, 高有效

    // 数据输入 (AXI4-Stream Slave)
    input  wire [5:0]              s_axis_tdata,   // 最大6bit(64QAM)
    input  wire                    s_axis_tvalid,
    output wire                    s_axis_tready,
    input  wire                    s_axis_tlast,

    // 数据输出 (AXI4-Stream Master)
    output wire [DATA_WIDTH*2-1:0] m_axis_tdata,   // {I[15:0], Q[15:0]}
    output wire                    m_axis_tvalid,
    input  wire                    m_axis_tready,
    output wire                    m_axis_tlast,

    // 配置接口 (见 [F1]: 当前未实现, 三个端口在模块内无使用)
    input  wire [31:0]             i_cfg_fft_len,
    input  wire [15:0]             i_cfg_cp_len,
    input  wire [3:0]              i_cfg_mod_type
);

    // ========================================================================
    // Internal connections
    // ========================================================================

    // Mod Mapper -> Pilot Insert
    wire [15:0]  w_mod_i;        // Q2.14
    wire [15:0]  w_mod_q;        // Q2.14
    wire         w_mod_valid;
    wire         w_mod_ready;
    wire         w_mod_last;

    // Pilot Insert -> IFFT (AXI4-Stream)
    wire [15:0]  w_ifft_in_i;    // Q2.14
    wire [15:0]  w_ifft_in_q;    // Q2.14
    wire         w_ifft_in_valid;
    wire         w_ifft_in_ready;

    // IFFT -> CP Insert (AXI4-Stream)
    wire [15:0]  w_ifft_out_i;   // Q3.13
    wire [15:0]  w_ifft_out_q;   // Q3.13
    wire         w_ifft_out_valid;
    wire         w_ifft_out_ready;
    wire         w_ifft_out_last;

    // ========================================================================
    // Stage 1: Mod Mapper
    // ========================================================================
    mod_mapper #(
        .MOD_TYPE (MOD_TYPE)
    ) u_mod_mapper (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .s_axis_tdata  (s_axis_tdata),
        .s_axis_tvalid (s_axis_tvalid),
        .s_axis_tready (s_axis_tready),
        .s_axis_tlast  (s_axis_tlast),
        .m_axis_i      (w_mod_i),
        .m_axis_q      (w_mod_q),
        .m_axis_tvalid (w_mod_valid),
        .m_axis_tready (w_mod_ready),
        .m_axis_tlast  (w_mod_last)
    );

    // ========================================================================
    // Stage 2: Pilot Insert + Subcarrier Mapping
    // ========================================================================
    pilot_insert #(
        .FFT_LEN    (FFT_LEN),
        .DATA_WIDTH (DATA_WIDTH)
    ) u_pilot_insert (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .s_axis_i      (w_mod_i),
        .s_axis_q      (w_mod_q),
        .s_axis_tvalid (w_mod_valid),
        .s_axis_tready (w_mod_ready),
        .s_axis_tlast  (w_mod_last),
        .m_axis_i      (w_ifft_in_i),
        .m_axis_q      (w_ifft_in_q),
        .m_axis_tvalid (w_ifft_in_valid),
        .m_axis_tready (w_ifft_in_ready)
    );

    // ========================================================================
    // Stage 3: IFFT (Xilinx FFT IP 占位模型)
    // 端口名沿用 Xilinx FFT IP 契约 (aclk/aresetn/s_axis_*/m_axis_*/event_*),
    // 属"标准总线保持协议原名"豁免; aresetn 低有效由本层做极性转换。
    // ========================================================================
    xfft_64 u_xfft (
        .aclk               (i_clk),
        .aresetn            (~i_rst),           // IP 契约为低有效, 此处转换
        .s_axis_config_tdata(16'h0001),         // FFT mode, scaling schedule
        .s_axis_config_tvalid(1'b1),
        .s_axis_config_tready(),
        .s_axis_data_tdata ({w_ifft_in_i, w_ifft_in_q}),
        .s_axis_data_tvalid(w_ifft_in_valid),
        .s_axis_data_tready(w_ifft_in_ready),
        .s_axis_data_tlast (1'b0),
        .m_axis_data_tdata ({w_ifft_out_i, w_ifft_out_q}),
        .m_axis_data_tvalid(w_ifft_out_valid),
        .m_axis_data_tready(w_ifft_out_ready),
        .m_axis_data_tlast (w_ifft_out_last),
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
        .i_clk          (i_clk),
        .i_rst          (i_rst),
        .s_axis_i       (w_ifft_out_i),
        .s_axis_q       (w_ifft_out_q),
        .s_axis_tvalid  (w_ifft_out_valid),
        .s_axis_tready  (w_ifft_out_ready),
        .s_axis_tlast   (w_ifft_out_last),
        .m_axis_tdata   (m_axis_tdata),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tlast   (m_axis_tlast)
    );

endmodule
