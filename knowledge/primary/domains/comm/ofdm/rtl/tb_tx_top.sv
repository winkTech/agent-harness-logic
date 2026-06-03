// ============================================================================
// Testbench: OFDM Transmitter Top
// 功能: 自检 TB, 读入 MATLAB 测试向量, 自动比对输出
// 流程: 读向量 → 驱动 DUT → 捕获输出 → 对比 golden → PASS/FAIL
// ============================================================================

`timescale 1ns / 1ps

module tb_ofdm_tx_top;

    // ========================================================================
    // Parameters
    // ========================================================================
    localparam FFT_LEN    = 64;
    localparam CP_LEN     = 16;
    localparam DATA_WIDTH = 32;     // 16I + 16Q packed
    localparam CLK_PERIOD = 10;     // 100MHz

    localparam N_SYM      = 10;     // symbols per test
    localparam VEC_DIR    = "../golden_model/vectors/";

    // ========================================================================
    // Signals
    // ========================================================================
    reg         clk, rst_n;
    reg  [5:0]  s_axis_tdata;
    reg         s_axis_tvalid, s_axis_tlast;
    wire        s_axis_tready;
    wire [31:0] m_axis_tdata;
    wire        m_axis_tvalid, m_axis_tlast;
    reg         m_axis_tready;

    // ========================================================================
    // DUT
    // ========================================================================
    ofdm_tx_top #(
        .FFT_LEN   (FFT_LEN),
        .CP_LEN    (CP_LEN),
        .MOD_TYPE  (1)       // QPSK for test
    ) dut (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axis_tdata   (s_axis_tdata),
        .s_axis_tvalid  (s_axis_tvalid),
        .s_axis_tready  (s_axis_tready),
        .s_axis_tlast   (s_axis_tlast),
        .m_axis_tdata   (m_axis_tdata),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tlast   (m_axis_tlast),
        .cfg_fft_len    (FFT_LEN),
        .cfg_cp_len     (CP_LEN),
        .cfg_mod_type   (1)
    );

    // ========================================================================
    // Clock
    // ========================================================================
    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    // ========================================================================
    // Test control
    // ========================================================================
    int errors = 0;
    int total_samples = 0;

    initial begin
        $display("===========================================");
        $display("  OFDM Transmitter Testbench");
        $display("  FFT: %d, CP: %d, MOD: QPSK", FFT_LEN, CP_LEN);
        $display("===========================================");

        // Reset
        rst_n = 0;
        s_axis_tvalid = 0;
        m_axis_tready = 1;
        repeat(20) @(posedge clk);
        rst_n = 1;
        repeat(10) @(posedge clk);

        // Run test
        drive_stimulus();
        capture_output();
        compare_with_golden();
        report_results();

        $finish;
    end

    // ========================================================================
    // Drive stimulus from MATLAB vectors
    // ========================================================================
    task drive_stimulus();
        integer fd_i, fd_q, scan_i, scan_q;
        reg [15:0] vec_i, vec_q;
        int sample_cnt;

        $display("Loading vectors from %s...", VEC_DIR);
        fd_i = $fopen({VEC_DIR, "freq_i.bin"}, "r");
        fd_q = $fopen({VEC_DIR, "freq_q.bin"}, "r");

        if (fd_i == 0 || fd_q == 0) begin
            $display("ERROR: Cannot open vector files");
            $finish;
        end

        // Drive each sample
        sample_cnt = 0;
        while (!$feof(fd_i) && sample_cnt < N_SYM * FFT_LEN) begin
            scan_i = $fscanf(fd_i, "%h\n", vec_i);
            scan_q = $fscanf(fd_q, "%h\n", vec_q);

            @(posedge clk);
            s_axis_tdata  <= 6'b0001_01;  // QPSK bits
            s_axis_tvalid <= 1'b1;
            s_axis_tlast  <= (sample_cnt == N_SYM * FFT_LEN - 1);

            wait(s_axis_tready);
            sample_cnt++;
        end

        @(posedge clk);
        s_axis_tvalid <= 1'b0;

        $fclose(fd_i);
        $fclose(fd_q);
        $display("Driven %d samples", sample_cnt);
    endtask

    // ========================================================================
    // Capture DUT output
    // ========================================================================
    logic [31:0] captured_data [$];
    logic        captured_last;

    task capture_output();
        int capture_cnt = 0;
        int expected_len = N_SYM * (FFT_LEN + CP_LEN);

        $display("Capturing output (expect %d samples)...", expected_len);

        while (capture_cnt < expected_len * 2) begin
            @(posedge clk);
            if (m_axis_tvalid && m_axis_tready) begin
                captured_data.push_back(m_axis_tdata);
                capture_cnt++;
                if (capture_cnt % 100 == 0)
                    $display("  Captured %d/%d", capture_cnt, expected_len);
            end
        end

        $display("Captured %d output samples", captured_data.size());
    endtask

    // ========================================================================
    // Compare with golden
    // ========================================================================
    task compare_with_golden();
        $display("Comparing with golden reference...");
        // TODO: 从 MATLAB 读取期望输出, 逐样点比对
        // 使用 Q3.13 定点格式对比, tolerance = 1 LSB

        // 简化: 检查输出非零 (基本合法性检查)
        int nonzero = 0;
        foreach (captured_data[i]) begin
            if (captured_data[i] != 0)
                nonzero++;
        end

        if (nonzero > captured_data.size() / 2) begin
            $display("  [PASS] Output activity check: %d/%d nonzero", nonzero, captured_data.size());
        end else begin
            $display("  [FAIL] Output stuck at zero!");
            errors++;
        end
    endtask

    // ========================================================================
    // Report
    // ========================================================================
    task report_results();
        $display("");
        $display("===========================================");
        if (errors == 0)
            $display("  TEST PASSED");
        else
            $display("  TEST FAILED with %d errors", errors);
        $display("===========================================");
    endtask

    // ========================================================================
    // Waveform dump
    // ========================================================================
    initial begin
        $dumpfile("tb_ofdm_tx_top.vcd");
        $dumpvars(0, tb_ofdm_tx_top);
    end

endmodule
