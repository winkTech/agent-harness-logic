// ============================================================================
// UVM Top Level: OFDM Transmitter
// 1. 生成时钟和复位
// 2. 例化 AXI4-Stream 接口 (s_axis 和 m_axis)
// 3. 例化 DUT
// 4. 设置虚接口 config_db
// 5. 调用 run_test()
// ============================================================================

`timescale 1ns / 1ps

import uvm_pkg::*;
`include "uvm_macros.svh"
import ofdm_uvm_pkg::*;

module tb_ofdm_uvm_top;

    // ========================================================================
    // Parameters
    // ========================================================================
    localparam CLK_PERIOD = 10;     // 100MHz

    // ========================================================================
    // Signals
    // ========================================================================
    logic clk;
    logic rst_n;

    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    // ========================================================================
    // AXI4-Stream Interfaces
    // ========================================================================

    // 输入接口: 16-bit (实际连接 DUT 低 6 位)
    axi_stream_if #(16) i_s_axis (.clk(clk));

    // 输出接口: 32-bit (I[15:0] + Q[15:0])
    axi_stream_if #(32) i_m_axis (.clk(clk));

    // 复位控制接口 (UVM 测试可访问)
    reset_if i_reset (.clk(clk));

    // 配置信号 (AXI4-Lite 风格)
    reg [31:0] cfg_fft_len;
    reg [15:0] cfg_cp_len;
    reg [3:0]  cfg_mod_type;

    // ========================================================================
    // DUT
    // ========================================================================
    ofdm_tx_top #(
        .FFT_LEN   (64),
        .CP_LEN    (16),
        .DATA_WIDTH(32),
        .MOD_TYPE  (1)
    ) dut (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axis_tdata   (i_s_axis.tdata[5:0]),
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

    // ========================================================================
    // Reset & Config & Output ready
    // ========================================================================
    initial begin
        rst_n = 0;
        i_reset.rst_n = 0;
        cfg_fft_len  = 64;
        cfg_cp_len   = 16;
        cfg_mod_type = 1;   // QPSK

        // 输出接口始终就绪 (UVM monitor 只采样, 不驱动 tready)
        force i_m_axis.tready = 1'b1;

        // 强制 DUT 复位跟踪 i_reset (UVM 测试可覆盖)
        force dut.rst_n = i_reset.rst_n;

        repeat(20) @(posedge clk);
        rst_n = 1;
        i_reset.rst_n = 1;
        repeat(10) @(posedge clk);
    end

    // ========================================================================
    // UVM Config DB: 设置虚接口
    // ========================================================================
    initial begin
        uvm_config_db #(virtual axi_stream_if #(16))::set(null,
            "uvm_test_top.env.agent.drv",    "vif", i_s_axis);
        uvm_config_db #(virtual axi_stream_if #(16))::set(null,
            "uvm_test_top.env.agent.in_mon", "vif", i_s_axis);
        uvm_config_db #(virtual axi_stream_if #(32))::set(null,
            "uvm_test_top.env.agent.out_mon", "vif", i_m_axis);

        // 设置为 base_test 可读的虚接口
        uvm_config_db #(virtual axi_stream_if #(16))::set(null,
            "uvm_test_top", "s_axis_vif", i_s_axis);
        uvm_config_db #(virtual axi_stream_if #(32))::set(null,
            "uvm_test_top", "m_axis_vif", i_m_axis);
        uvm_config_db #(virtual reset_if)::set(null,
            "uvm_test_top", "reset_vif", i_reset);
    end

    // ========================================================================
    // UVM Start (必须在 0 时刻调用 run_test)
    // ========================================================================
    initial begin
        run_test("ofdm_basic_test");
    end

    // ========================================================================
    // Waveform Dump
    // ========================================================================
    initial begin
        $dumpfile("tb_ofdm_uvm_top.vcd");
        $dumpvars(0, tb_ofdm_uvm_top);
    end

endmodule
