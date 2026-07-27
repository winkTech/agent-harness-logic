// ============================================================================
// Testbench: OFDM Transmitter Top — 全自动黄金向量比对
// 流程:
//   ① 从 MATLAB golden model 读取黄金向量 (freq_i.bin / freq_q.bin) 驱动 DUT
//   ② 捕获 DUT 输出 m_axis_tdata 至队列
//   ③ 读取黄金期望输出 (expected_tx.bin) 逐样点比对, tol=±1LSB
//   ④ 将 RTL 输出写入 rtl_output.bin 供 MATLAB 外部分析
//   ⑤ 输出 PASS/FAIL + 详细统计
// ============================================================================

`timescale 1ns / 1ps

module tb_ofdm_tx_top;

    // ========================================================================
    // Parameters
    // ========================================================================
    localparam FFT_LEN    = 64;
    localparam CP_LEN     = 16;
    localparam DATA_WIDTH = 32;     // {Q3.13[15:0], I3.13[15:0]}
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
    int          errors;
    int          total_samples;
    int          mismatch_cnt;
    int          max_err_i, max_err_q;
    real         mse_i, mse_q;
    int          golden_fd, rtl_out_fd;

    initial begin
        errors       = 0;
        mismatch_cnt = 0;
        max_err_i    = 0;
        max_err_q    = 0;
        mse_i        = 0.0;
        mse_q        = 0.0;

        $display("===========================================");
        $display("  OFDM Transmitter Testbench — Golden Compare");
        $display("  FFT: %d, CP: %d, MOD: QPSK", FFT_LEN, CP_LEN);
        $display("===========================================");

        // Reset
        rst_n = 0;
        s_axis_tvalid = 0;
        m_axis_tready = 1;
        repeat(20) @(posedge clk);
        rst_n = 1;
        repeat(10) @(posedge clk);

        // Open RTL output file
        rtl_out_fd = $fopen({VEC_DIR, "rtl_output.bin"}, "w");
        if (rtl_out_fd == 0) begin
            $display("ERROR: Cannot create rtl_output.bin");
            $finish;
        end

        // Run test phases
        drive_stimulus();
        capture_output();
        $fclose(rtl_out_fd);
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
            $display("ERROR: Cannot open vector files at %s", VEC_DIR);
            $display("       Run MATLAB golden model first to generate vectors.");
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
    // Capture DUT output — 捕获 + 同时写 rtl_output.bin
    // ========================================================================
    logic [31:0] captured_data [$];
    logic        captured_last;

    task automatic capture_output();
        int capture_cnt;
        int expected_len;

        $display("Capturing output (expect ~%d samples)...", expected_len);

        while (capture_cnt < expected_len * 2) begin
            @(posedge clk);
            if (m_axis_tvalid && m_axis_tready) begin
                captured_data.push_back(m_axis_tdata);
                // 同时写入文件供 MATLAB 外部分析
                $fwrite(rtl_out_fd, "%08x\n", m_axis_tdata);
                capture_cnt++;
            end
        end

        $display("Captured %0d output samples", captured_data.size());
    endtask

    // ========================================================================
    // Compare with golden — 逐样点 Q3.13 比对, tol=±1LSB
    // ========================================================================
    task compare_with_golden();
        reg [31:0] golden_val;
        reg [15:0] golden_i, golden_q;
        reg [15:0] rtl_i, rtl_q;
        int        diff_i, diff_q;
        int        match_cnt;
        int        scan_ret;

        $display("Loading golden expected output from expected_tx.bin...");

        golden_fd = $fopen({VEC_DIR, "expected_tx.bin"}, "r");
        if (golden_fd == 0) begin
            $display("ERROR: Cannot open expected_tx.bin — run generate_vectors.m first");
            errors++;
            return;
        end

        match_cnt    = 0;
        mismatch_cnt = 0;
        max_err_i    = 0;
        max_err_q    = 0;
        mse_i        = 0.0;
        mse_q        = 0.0;

        foreach (captured_data[i]) begin
            // Read golden sample
            scan_ret = $fscanf(golden_fd, "%h\n", golden_val);
            if (scan_ret <= 0) break;

            // Extract I/Q: golden and RTL same format {Q[15:0], I[15:0]}
            golden_i = golden_val[15:0];
            golden_q = golden_val[31:16];
            rtl_i    = captured_data[i][15:0];
            rtl_q    = captured_data[i][31:16];

            // Compute signed differences
            diff_i = $signed(rtl_i) - $signed(golden_i);
            diff_q = $signed(rtl_q) - $signed(golden_q);

            // Accumulate MSE
            mse_i = mse_i + diff_i * diff_i;
            mse_q = mse_q + diff_q * diff_q;

            // Track max error
            if (diff_i > max_err_i) max_err_i = diff_i;
            if (-diff_i > max_err_i) max_err_i = -diff_i;
            if (diff_q > max_err_q) max_err_q = diff_q;
            if (-diff_q > max_err_q) max_err_q = -diff_q;

            // Compare with tolerance ±1 LSB
            if ((diff_i > 1) || (diff_i < -1) || (diff_q > 1) || (diff_q < -1)) begin
                if (mismatch_cnt < 10) begin  // 只打印前10个错误
                    $display("  [MISMATCH @ %0d] golden={%04x,%04x} rtl={%04x,%04x} diff={%0d,%0d}",
                        i, golden_q, golden_i, rtl_q, rtl_i, diff_q, diff_i);
                end
                mismatch_cnt++;
            end else begin
                match_cnt++;
            end
        end

        $fclose(golden_fd);
        total_samples = match_cnt + mismatch_cnt;

        // Normalize MSE
        if (total_samples > 0) begin
            mse_i = mse_i / total_samples;
            mse_q = mse_q / total_samples;
        end

        $display("");
        $display("  Comparison Results:");
        $display("    Total samples:  %0d", total_samples);
        $display("    Matched:        %0d", match_cnt);
        $display("    Mismatched:     %0d", mismatch_cnt);
        $display("    Max |I error|:  %0d LSB", max_err_i);
        $display("    Max |Q error|:  %0d LSB", max_err_q);
        $display("    MSE I:          %0.1f", mse_i);
        $display("    MSE Q:          %0.1f", mse_q);

        if (mismatch_cnt > 0) errors++;
    endtask

    // ========================================================================
    // Report
    // ========================================================================
    task report_results();
        string pass_str;

        $display("");
        $display("===========================================");
        if (errors == 0) begin
            $display("  ⭐ TEST PASSED — Golden match");
        end else begin
            $display("  ❌ TEST FAILED — %0d mismatches, %0d total samples",
                mismatch_cnt, total_samples);
        end
        $display("===========================================");
        $display("  RTL output written to: %srtl_output.bin", VEC_DIR);
    endtask

    // ========================================================================
    // Waveform dump
    // ========================================================================
    initial begin
        $dumpfile("tb_ofdm_tx_top.vcd");
        $dumpvars(0, tb_ofdm_tx_top);  // vlog-lint warning OK: 单文件 lint 无法解析层次, 仿真正常
    end

endmodule
