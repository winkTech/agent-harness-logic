// ============================================================================
// LDPC Decoder UVM Top
// 顶层: 实例化 DUT, 时钟, 接口, 启动 test
// ============================================================================

`timescale 1ns / 1ps

module tb_ldpc_uvm_top;

    import uvm_pkg::*;
    `include "uvm_macros.svh"

    import ldpc_uvm_pkg::*;

    // ========================================================================
    // 参数
    // ========================================================================
    localparam CLK_PERIOD = 10;  // 100 MHz

    // ========================================================================
    // 信号
    // ========================================================================
    logic          clk;
    logic          rst_n;

    // LLR 输入 (10-bit signed)
    logic [9:0]    s_axis_llr_tdata;
    logic          s_axis_llr_tvalid;
    logic          s_axis_llr_tready;

    // 译码输出 (1-bit)
    logic          m_axis_data_tdata;
    logic          m_axis_data_tvalid;
    logic          m_axis_data_tready;

    // ========================================================================
    // DUT
    // ========================================================================
    ldpc_decoder_top u_dut (
        .i_clk_sys          (clk),
        .i_rst_sys          (~rst_n),
        .s_axis_llr_tdata   (s_axis_llr_tdata),
        .s_axis_llr_tvalid  (s_axis_llr_tvalid),
        .s_axis_llr_tready  (s_axis_llr_tready),
        .m_axis_data_tdata  (m_axis_data_tdata),
        .m_axis_data_tvalid (m_axis_data_tvalid),
        .m_axis_data_tready (m_axis_data_tready)
    );

    // ========================================================================
    // 接口实例化
    // ========================================================================
    reset_if        rst_if    (.clk(clk));

    // ========================================================================
    // 时钟
    // ========================================================================
    initial clk = 0;
    always #(CLK_PERIOD / 2) clk = ~clk;

    // ========================================================================
    // 复位
    // ========================================================================
    initial begin
        rst_n <= 0;
        rst_if.rst_n <= 0;
        repeat (10) @(posedge clk);
        rst_n <= 1;
        rst_if.rst_n <= 1;
    end

    // ========================================================================
    // UVM 启动
    // ========================================================================
    initial begin
        uvm_config_string::set(null, "uvm_test_top", "vec_dir", "../golden_model/vectors/");
        run_test("ldpc_basic_test");
    end

    // ========================================================================
    // 波形
    // ========================================================================
    initial begin
        $dumpfile("tb_ldpc_uvm_top.vcd");
        $dumpvars(0, tb_ldpc_uvm_top);
    end

endmodule : tb_ldpc_uvm_top
