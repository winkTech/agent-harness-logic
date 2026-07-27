// ============================================================================
// mod_mapper — 适配层: 桥接 ofdm_tx_top 的例化接口 → mapper 模块
// ofdm_tx_top 例化 mod_mapper 但源文件为 mapper, 本文件做端口适配
// ============================================================================

`timescale 1ns / 1ps

module mod_mapper #(
    parameter MOD_TYPE = 2
)(
    input  wire         clk,
    input  wire         rst_n,
    input  wire [5:0]   s_axis_tdata,
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    input  wire         s_axis_tlast,
    output wire [15:0]  m_axis_i,
    output wire [15:0]  m_axis_q,
    output wire         m_axis_tvalid,
    input  wire         m_axis_tready,
    output wire         m_axis_tlast
);

    mapper #(
        .P_MOD_TYPE (MOD_TYPE)
    ) u_mapper (
        .i_clk_sys      (clk),
        .i_rst_sys      (!rst_n),
        .s_axis_tdata   (s_axis_tdata),
        .s_axis_tvalid  (s_axis_tvalid),
        .s_axis_tready  (s_axis_tready),
        .s_axis_tlast   (s_axis_tlast),
        .m_axis_i       (m_axis_i),
        .m_axis_q       (m_axis_q),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tlast   (m_axis_tlast)
    );

endmodule
