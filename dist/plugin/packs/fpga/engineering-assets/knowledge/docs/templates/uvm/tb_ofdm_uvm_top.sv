// ============================================================================
// UVM Top Level: OFDM Transmitter (使用通用 #(32) 接口)
// ============================================================================

`timescale 1ns / 1ps

import uvm_pkg::*;
`include "uvm_macros.svh"
import ofdm_uvm_pkg::*;

module tb_ofdm_uvm_top;

    localparam CLK_PERIOD = 10;

    logic clk;
    logic rst_n;

    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    // 统一使用 #(32) 接口
    axi_stream_if #(32) i_s_axis (.clk(clk));
    axi_stream_if #(32) i_m_axis (.clk(clk));
    reset_if i_reset (.clk(clk));

    reg [31:0] cfg_fft_len;
    reg [15:0] cfg_cp_len;
    reg [3:0]  cfg_mod_type;

    ofdm_tx_top #(
        .FFT_LEN   (64),
        .CP_LEN    (16),
        .DATA_WIDTH(32),
        .MOD_TYPE  (1)
    ) dut (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axis_tdata   (i_s_axis.tdata[5:0]),  // 截低6bit
        .s_axis_tvalid  (i_s_axis.tvalid),
        .s_axis_tready  (i_s_axis.tready),
        .s_axis_tlast   (i_s_axis.tlast),
        .m_axis_tdata   (i_m_axis.tdata),
        .m_axis_tvalid  (i_m_axis.tvalid),
        .m_axis_tready  (i_m_axis.tready),
        .m_axis_tlast   (i_m_axis.tlast),
        .cfg_fft_len    (cfg_fft_len),
        .cfg_cp_len     (cfg_cp_len),
        .cfg_mod_type   (cfg_mod_type)
    );

    initial begin
        rst_n = 0; i_reset.rst_n = 0;
        cfg_fft_len  = 64;
        cfg_cp_len   = 16;
        cfg_mod_type = 1;
        force i_m_axis.tready = 1'b1;
        force dut.rst_n = i_reset.rst_n;
        repeat(20) @(posedge clk);
        rst_n = 1; i_reset.rst_n = 1;
        repeat(10) @(posedge clk);
    end

    initial begin
        uvm_config_db #(virtual axi_stream_if #(32))::set(null,
            "uvm_test_top.env.agent.drv",    "vif", i_s_axis);
        uvm_config_db #(virtual axi_stream_if #(32))::set(null,
            "uvm_test_top.env.agent.in_mon", "vif", i_s_axis);
        uvm_config_db #(virtual axi_stream_if #(32))::set(null,
            "uvm_test_top.env.agent.out_mon", "vif", i_m_axis);

        uvm_config_db #(virtual axi_stream_if #(32))::set(null,
            "uvm_test_top", "s_axis_vif", i_s_axis);
        uvm_config_db #(virtual axi_stream_if #(32))::set(null,
            "uvm_test_top", "m_axis_vif", i_m_axis);
        uvm_config_db #(virtual reset_if)::set(null,
            "uvm_test_top", "reset_vif", i_reset);
    end

    initial begin
        run_test("ofdm_basic_test");
    end

    initial begin
        $dumpfile("tb_ofdm_uvm_top.vcd");
        $dumpvars(0, tb_ofdm_uvm_top);
    end

endmodule