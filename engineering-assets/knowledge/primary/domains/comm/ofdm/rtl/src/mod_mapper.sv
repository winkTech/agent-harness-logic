// ============================================================================
// mod_mapper — 适配层: 桥接 ofdm_tx_top 的例化接口 → mapper 模块
// ofdm_tx_top 例化 mod_mapper 但源文件为 mapper, 本文件做端口适配
//
// 名称: mod_mapper
// 功能: 纯端口适配壳, 无自有逻辑
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (比特流) / m_axis (I/Q 符号)
// 主要逻辑: 直接例化 mapper 并透传全部信号
//
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   端口 clk/rst_n -> i_clk/i_rst, 复位改同步高有效。
//   修复前本壳的存在意义之一是做 `!rst_n` 极性翻转 (mapper 内部本就是
//   同步高有效); 现在上下游极性统一, 翻转取消, 直连即可。
// ============================================================================

`timescale 1ns / 1ps

module mod_mapper #(
    parameter MOD_TYPE = 2
)(
    input  wire         i_clk,
    input  wire         i_rst,       // 同步复位, 高有效
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
        .i_clk_sys      (i_clk),
        .i_rst_sys      (i_rst),     // 极性已统一, 无需翻转
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
