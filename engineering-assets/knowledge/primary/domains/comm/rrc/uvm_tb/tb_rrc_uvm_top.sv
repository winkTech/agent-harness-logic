// ============================================================================
// UVM Top Level: RRC Pulse Shaping Filter
// 1. 时钟 + 复位 + DUT 例化
// 2. AXI4-Stream 接口 (I/O 均为 32-bit {Q,I})
// 3. config_db 注入虚接口
// 4. run_test("rrc_basic_test")
// ============================================================================

`timescale 1ns / 1ps

import uvm_pkg::*;
`include "uvm_macros.svh"
import rrc_uvm_pkg::*;

module tb_rrc_uvm_top;

    localparam CLK_PERIOD = 10;  // 100MHz

    // ---- 信号 ----
    logic clk;
    logic rst_n;

    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    // ---- AXI4-Stream 接口 ----
    axi_stream_if #(32) i_s_axis (.clk(clk));  // 输入 {Q[15:0], I[15:0]}
    axi_stream_if #(32) i_m_axis (.clk(clk));  // 输出 {Q[15:0], I[15:0]}
    reset_if i_reset (.clk(clk));

    // ---- DUT ----
    // 2026-07-28 随 RTL 规范整改同步更新: clk/rst_n/alpha_sel ->
    // i_clk/i_rst/i_alpha_sel, 复位改**同步高有效** (i_rst=1 为复位)。
    // 接口侧 reset_if 仍是低有效 rst_n 语义, 故此处取反后再驱动 DUT。
    rrc_top #(.DATA_W(16)) u_dut (
        .i_clk          (clk),
        .i_rst          (~rst_n),
        .s_axis_tvalid  (i_s_axis.tvalid),
        .s_axis_tready  (i_s_axis.tready),
        .s_axis_tdata   (i_s_axis.tdata),
        .m_axis_tvalid  (i_m_axis.tvalid),
        .m_axis_tready  (i_m_axis.tready),
        .m_axis_tdata   (i_m_axis.tdata),
        .i_alpha_sel    (8'h02)   // alpha=0.5
    );

    // ---- 复位 & 输出就绪 ----
    initial begin
        rst_n = 0;
        i_reset.rst_n = 0;
        force i_m_axis.tready = 1'b1;
        // 原先 force u_dut.rst_n —— DUT 已无该端口, 且复位现由上方 .i_rst(~rst_n)
        // 连接驱动, 无需再 force 到模块内部。

        repeat(20) @(posedge clk);
        rst_n = 1;
        i_reset.rst_n = 1;
        repeat(10) @(posedge clk);
    end

    // ---- config_db 注入 ----
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
        run_test("rrc_basic_test");
    end

    initial begin
        $dumpfile("tb_rrc_uvm_top.vcd");
        $dumpvars(0, tb_rrc_uvm_top);
    end

endmodule