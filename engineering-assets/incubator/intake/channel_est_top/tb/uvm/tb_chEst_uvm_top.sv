// ============================================================================
// UVM Top Level: Channel Estimation
// ============================================================================

`timescale 1ns / 1ps

import uvm_pkg::*;
`include "uvm_macros.svh"
import chEst_uvm_pkg::*;

module tb_chEst_uvm_top;

    localparam CLK_PERIOD = 10;

    logic clk;
    logic rst_n;

    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    axi_stream_if #(32) i_s_axis (.clk(clk));
    axi_stream_if #(32) i_m_axis (.clk(clk));
    reset_if i_reset (.clk(clk));

    channel_est_top #(.DATA_W(16)) u_dut (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axis_tvalid  (i_s_axis.tvalid),
        .s_axis_tready  (i_s_axis.tready),
        .s_axis_tdata   (i_s_axis.tdata),
        .m_axis_tvalid  (i_m_axis.tvalid),
        .m_axis_tready  (i_m_axis.tready),
        .m_axis_tdata   (i_m_axis.tdata)
    );

    initial begin
        rst_n = 0; i_reset.rst_n = 0;
        force i_m_axis.tready = 1'b1;
        force u_dut.rst_n = i_reset.rst_n;
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
        run_test("chEst_basic_test");
    end

    initial begin
        $dumpfile("tb_chEst_uvm_top.vcd");
        $dumpvars(0, tb_chEst_uvm_top);
    end

endmodule