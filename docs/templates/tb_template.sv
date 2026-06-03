// ============================================================================
// Testbench: <模块名称>
// 功能: 自检 Testbench，自动比对 MATLAB 测试向量
// ============================================================================

`timescale 1ns / 1ps

module tb_<module_name>;

    // ========================================================================
    // Parameters
    // ========================================================================
    localparam DATA_WIDTH = 16;
    localparam CLK_PERIOD = 10; // 100MHz
    localparam VECTOR_FILE = "../../vectors/tx_data.bin";

    // ========================================================================
    // Signals
    // ========================================================================
    reg                  clk, rst_n;
    reg  [DATA_WIDTH-1:0] s_axis_tdata;
    reg                  s_axis_tvalid, m_axis_tready;
    wire                 s_axis_tready;
    wire [DATA_WIDTH-1:0] m_axis_tdata;
    wire                 m_axis_tvalid, m_axis_tlast;

    // ========================================================================
    // DUT
    // ========================================================================
    <module_name> #(
        .DATA_WIDTH(DATA_WIDTH)
    ) dut (
        .clk(clk), .rst_n(rst_n),
        .s_axis_tdata(s_axis_tdata),
        .s_axis_tvalid(s_axis_tvalid),
        .s_axis_tready(s_axis_tready),
        .s_axis_tlast(1'b0),
        .m_axis_tdata(m_axis_tdata),
        .m_axis_tvalid(m_axis_tvalid),
        .m_axis_tready(m_axis_tready),
        .m_axis_tlast(m_axis_tlast),
        .enable(1'b1)
    );

    // ========================================================================
    // Clock generation
    // ========================================================================
    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    // ========================================================================
    // Test sequence
    // ========================================================================
    initial begin
        $display("========================================");
        $display("  TB: <module_name>");
        $display("========================================");

        // Reset
        rst_n = 0;
        repeat(10) @(posedge clk);
        rst_n = 1;
        repeat(5) @(posedge clk);

        // Read vectors and drive DUT
        run_test();

        // Check results
        check_results();

        $display("========================================");
        $display("  TEST %s", passed ? "PASSED" : "FAILED");
        $display("========================================");
        $finish;
    end

    // ========================================================================
    // Tasks
    // ========================================================================
    task run_test();
        // TODO: read vector file, drive inputs
        m_axis_tready = 1;
        s_axis_tvalid = 1;
        s_axis_tdata  = 16'h1234;
        repeat(100) @(posedge clk);
        s_axis_tvalid = 0;
    endtask

    task check_results();
        // TODO: compare with MATLAB golden output
    endtask

endmodule
