// ============================================================================
// Testbench: Channel Estimation — 文件驱动黄金向量比对
// 流程:
//   ① 从 MATLAB golden model 读取 rx_chEst.bin 驱动 DUT
//   ② 捕获 DUT 输出 m_axis_tdata 至队列
//   ③ 将 RTL 输出写入 rtl_chEst_out.bin 供 MATLAB 外部分析
//   ④ 读取黄金期望 expected_chEst.bin 逐样点比对, tol=±3LSB
//   ⑤ 输出 PASS/FAIL + 统计
//
// 用法:
//   vsim -c -do "vsim work.tb_chEst_cosim; run -all; quit"
// ============================================================================

`timescale 1ns / 1ps

module tb_chEst_cosim;

    // ========================================================================
    // Parameters
    // ========================================================================
    localparam DATA_W     = 16;
    localparam N_FFT      = 64;
    localparam CLK_PERIOD = 10;        // 100 MHz
    // 向量目录由 run.do 经 +VEC_DIR 注入（库级约定，见治理规范 §5.5）。
    // 权威位置 = models/comm/channel_est/vectors/。
    // 原值 "../../golden_model/vectors/" 指向不存在的目录，向量从未被真正读到。
    string VEC_DIR;

    // ========================================================================
    // Signals
    // ========================================================================
    logic         clk, rst_n;
    logic         s_axis_tvalid, s_axis_tready;
    logic [31:0]  s_axis_tdata;
    logic         m_axis_tvalid, m_axis_tready;
    logic [31:0]  m_axis_tdata;

    // ========================================================================
    // DUT
    // ========================================================================
    channel_est_top #(
        .DATA_W(DATA_W)
    ) dut (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axis_tvalid  (s_axis_tvalid),
        .s_axis_tready  (s_axis_tready),
        .s_axis_tdata   (s_axis_tdata),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tdata   (m_axis_tdata)
    );

    // ========================================================================
    // Clock
    // ========================================================================
    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    // ========================================================================
    // Test control
    // ========================================================================
    int errors;
    int match_cnt, mismatch_cnt;
    int max_err_i, max_err_q;
    real mse_i, mse_q;
    int rtl_out_fd, golden_fd;

    initial begin
        errors       = 0;
        match_cnt    = 0;
        mismatch_cnt = 0;
        max_err_i    = 0;
        max_err_q    = 0;
        mse_i        = 0.0;
        mse_q        = 0.0;

        $display("================================================");
        $display("  Channel Estimator Co-Simulation Testbench");
        $display("  N_FFT: %d, DATA_W: %d", N_FFT, DATA_W);
        $display("================================================");

        // Reset
        rst_n = 0;
        s_axis_tvalid = 0;
        m_axis_tready = 1;
        repeat (20) @(posedge clk);
        rst_n = 1;
        repeat (10) @(posedge clk);

        // 向量目录注入；缺失即 fail-closed，不得回落默认路径（规范 §5.5 V-2）
        if (!$value$plusargs("VEC_DIR=%s", VEC_DIR))
            $fatal(1, "缺 +VEC_DIR — 向量权威位置 models/comm/channel_est/vectors/, 须由 run.do 注入");

        // Open RTL output file
        rtl_out_fd = $fopen({VEC_DIR, "rtl_chEst_out.bin"}, "w");
        if (rtl_out_fd == 0)
            $fatal(1, "无法在 %s 创建 rtl_chEst_out.bin", VEC_DIR);

        // Run test
        drive_stimulus();
        capture_output();
        $fclose(rtl_out_fd);
        compare_with_golden();
        report_results();

        $finish;
    end

    // ========================================================================
    // Drive stimulus from rx_chEst.bin (Y received signal)
    // ========================================================================
    task drive_stimulus();
        integer fd, scan_ret;
        reg [31:0] vec_val;
        int sample_cnt;

        $display("Loading stimulus from %srx_chEst.bin...", VEC_DIR);
        fd = $fopen({VEC_DIR, "rx_chEst.bin"}, "r");
        if (fd == 0) begin
            $display("ERROR: Cannot open rx_chEst.bin at %s", VEC_DIR);
            $display("       Run MATLAB golden model first to generate vectors.");
            $finish;
        end

        sample_cnt = 0;
        while (!$feof(fd) && sample_cnt < N_FFT) begin
            scan_ret = $fscanf(fd, "%h\n", vec_val);
            if (scan_ret <= 0) break;

            @(posedge clk);
            s_axis_tdata  <= vec_val;
            s_axis_tvalid <= 1'b1;
            m_axis_tready <= 1'b1;

            wait(s_axis_tready);
            sample_cnt++;
        end

        @(posedge clk);
        s_axis_tvalid <= 1'b0;
        $fclose(fd);
        $display("  Driven %0d subcarriers", sample_cnt);
    endtask

    // ========================================================================
    // Capture DUT output — 捕获 + 同时写入 rtl_chEst_out.bin
    // ========================================================================
    logic [31:0] captured_data [$];

    task automatic capture_output();
        int capture_cnt;
        int max_wait;

        $display("Capturing output (expect ~%d samples)...", N_FFT);

        capture_cnt = 0;
        max_wait    = 10000;  // safety timeout

        while (capture_cnt < N_FFT && max_wait > 0) begin
            @(posedge clk);
            max_wait--;
            if (m_axis_tvalid && m_axis_tready) begin
                captured_data.push_back(m_axis_tdata);
                $fwrite(rtl_out_fd, "%08x\n", m_axis_tdata);
                capture_cnt++;
            end
        end

        if (max_wait == 0) begin
            $display("WARNING: Capture timeout after %0d samples", capture_cnt);
        end

        $display("  Captured %0d output samples", captured_data.size());
    endtask

    // ========================================================================
    // Compare with golden — Q2.14 逐子载波比对, tol=±3LSB
    // ========================================================================
    task compare_with_golden();
        reg [31:0] golden_val;
        reg [15:0] golden_i, golden_q;
        reg [15:0] rtl_i, rtl_q;
        int diff_i, diff_q;
        int scan_ret;

        $display("Loading golden expected output from expected_chEst.bin...");

        golden_fd = $fopen({VEC_DIR, "expected_chEst.bin"}, "r");
        if (golden_fd == 0) begin
            $display("ERROR: Cannot open expected_chEst.bin — run generate_vectors.m first");
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
            scan_ret = $fscanf(golden_fd, "%h\n", golden_val);
            if (scan_ret <= 0) break;

            golden_i = golden_val[15:0];
            golden_q = golden_val[31:16];
            rtl_i    = captured_data[i][15:0];
            rtl_q    = captured_data[i][31:16];

            diff_i = $signed(rtl_i) - $signed(golden_i);
            diff_q = $signed(rtl_q) - $signed(golden_q);

            mse_i = mse_i + diff_i * diff_i;
            mse_q = mse_q + diff_q * diff_q;

            if (diff_i > max_err_i) max_err_i = diff_i;
            if (-diff_i > max_err_i) max_err_i = -diff_i;
            if (diff_q > max_err_q) max_err_q = diff_q;
            if (-diff_q > max_err_q) max_err_q = -diff_q;

            // X/Z 显式计为失配（规范 §5.5 V-5）：$signed(x)-$signed(g) 得 X，
            // 而 (X > 3) 求值为 X、被 if 当作假 —— 全 X 输出会被静默判为"匹配"。
            if ((^captured_data[i]) === 1'bx) begin
                if (mismatch_cnt < 10)
                    $display("  [X/Z @ SC%0d] rtl=%08x — 输出未定义, 计为失配", i, captured_data[i]);
                mismatch_cnt++;
            end
            // ChEst outputs quantized H_est, tolerance ±3 LSB due to interpolation rounding
            else if ((diff_i > 3) || (diff_i < -3) || (diff_q > 3) || (diff_q < -3)) begin
                if (mismatch_cnt < 10) begin
                    $display("  [MISMATCH @ SC%0d] golden={%04x,%04x} rtl={%04x,%04x} diff={%0d,%0d}",
                        i, golden_q, golden_i, rtl_q, rtl_i, diff_q, diff_i);
                end
                mismatch_cnt++;
            end else begin
                match_cnt++;
            end
        end

        $fclose(golden_fd);

        if ((match_cnt + mismatch_cnt) > 0) begin
            mse_i = mse_i / (match_cnt + mismatch_cnt);
            mse_q = mse_q / (match_cnt + mismatch_cnt);
        end

        $display("");
        $display("  Comparison Results:");
        $display("    Total subcarriers: %0d", match_cnt + mismatch_cnt);
        $display("    Matched:           %0d", match_cnt);
        $display("    Mismatched:        %0d", mismatch_cnt);
        $display("    Max |I error|:     %0d LSB", max_err_i);
        $display("    Max |Q error|:     %0d LSB", max_err_q);
        $display("    MSE I:             %0.1f", mse_i);
        $display("    MSE Q:             %0.1f", mse_q);

        if (mismatch_cnt > 0) errors++;
    endtask

    // ========================================================================
    // Report
    // ========================================================================
    task report_results();
        $display("");
        $display("================================================");
        if (errors == 0) begin
            $display("  ⭐ CHEST COSIM PASSED — Golden match");
        end else begin
            $display("  ❌ CHEST COSIM FAILED — %0d mismatches / %0d total",
                mismatch_cnt, match_cnt + mismatch_cnt);
        end
        $display("================================================");
        $display("  RTL output: %srtl_chEst_out.bin", VEC_DIR);
    endtask

    // ========================================================================
    // Waveform dump
    // ========================================================================
    initial begin
        $dumpfile("tb_chEst_cosim.vcd");
        $dumpvars(0, tb_chEst_cosim);
    end

endmodule
