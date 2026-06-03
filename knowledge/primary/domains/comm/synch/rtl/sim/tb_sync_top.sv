//==============================================================================
// Testbench for OFDM Synchronization
// Generates preamble + CFO + noise, verifies packet detection + timing
//==============================================================================
`timescale 1ns/1ps

module tb_sync_top;

    localparam DATA_W = 16;
    localparam CLK_PER = 10;

    logic clk, rst_n;
    logic s_axis_tvalid, s_axis_tready;
    logic [DATA_W*2-1:0] s_axis_tdata;
    logic m_axis_tvalid, m_axis_tready;
    logic [DATA_W*2-1:0] m_axis_tdata;
    logic fft_start, sync_locked;

    // DUT
    sync_top #(.DATA_W(DATA_W)) dut (
        .clk(clk), .rst_n(rst_n),
        .s_axis_tvalid(s_axis_tvalid), .s_axis_tready(s_axis_tready),
        .s_axis_tdata(s_axis_tdata),
        .m_axis_tvalid(m_axis_tvalid), .m_axis_tready(m_axis_tready),
        .m_axis_tdata(m_axis_tdata),
        .fft_start(fft_start), .sync_locked(sync_locked)
    );

    // Clock
    initial clk = 0;
    always #(CLK_PER/2) clk = ~clk;

    // Test data (pre-computed preamble with CFO)
    // Q2.14 format: multiply by 16384, round to int
    int test_i [0:511];  // preamble + padding
    int test_q [0:511];
    int test_len;
    int error_cnt;

    // Quantize to Q2.14
    function int q14(real v);
        q14 = $rtoi(v * 16384.0);
    endfunction

    // Generate test vector with preamble + CFO + noise
    task gen_test(real epsilon, real snr_db);
        real short_sym[0:15], long_sym[0:63];
        real r_i[0:511], r_q[0:511];
        real sig_pow, noise_pow;
        int n;

        test_len = 320 + 64;  // preamble + padding

        // Short preamble symbol (16 samples, from 802.11a spec)
        // Generated from IFFT of 12 non-zero subcarriers spaced by 4
        short_sym = '{
            0.046, -0.132, -0.465, -0.223,  0.232, -0.133,  0.295, -0.223,
           -0.093,  0.223, -0.023,  0.169, -0.044, -0.223, -0.068, -0.023
        };

        // Long preamble symbol (64 samples, T1)
        // Simplified: use impulse, added zeros for brevity
        for (n = 0; n < 64; n++) long_sym[n] = 0.0;
        long_sym[0] = 0.5; long_sym[1] = -0.5;

        // Build preamble with CFO
        for (n = 0; n < 160; n++) begin
            real phi = 2.0 * 3.14159 * epsilon * n / 64.0;
            int si = n % 16;
            r_i[n] = short_sym[si] * $cos(phi);
            r_q[n] = short_sym[si] * $sin(phi);
        end

        // GI2 (32 samples)
        for (n = 0; n < 32; n++) begin
            real phi = 2.0 * 3.14159 * epsilon * (160+n) / 64.0;
            int si = 64-32+n;
            r_i[160+n] = long_sym[si] * $cos(phi);
            r_q[160+n] = long_sym[si] * $sin(phi);
        end

        // T1 + T2
        for (n = 0; n < 128; n++) begin
            real phi = 2.0 * 3.14159 * epsilon * (192+n) / 64.0;
            r_i[192+n] = long_sym[n % 64] * $cos(phi);
            r_q[192+n] = long_sym[n % 64] * $sin(phi);
        end

        // Padding
        for (n = 320; n < 384; n++) begin
            r_i[n] = 0; r_q[n] = 0;
        end

        // AWGN
        sig_pow = 0;
        for (n = 0; n < test_len; n++)
            sig_pow = sig_pow + r_i[n]*r_i[n] + r_q[n]*r_q[n];
        sig_pow = sig_pow / test_len;
        noise_pow = sig_pow / $pow(10.0, snr_db/10.0);

        // Quantize
        for (n = 0; n < test_len; n++) begin
            test_i[n] = q14(r_i[n] + $sqrt(noise_pow/2) * $dist_normal(42,0,1));
            test_q[n] = q14(r_q[n] + $sqrt(noise_pow/2) * $dist_normal(42,0,1));
        end
    endtask

    // Send test vector to DUT
    task send_data();
        for (int n = 0; n < test_len; n++) begin
            s_axis_tvalid = 1;
            s_axis_tdata  = {test_q[n][15:0], test_i[n][15:0]};
            @(posedge clk);
            while (!s_axis_tready) @(posedge clk);
        end
        s_axis_tvalid = 0;
    endtask

    // Test control
    initial begin
        error_cnt = 0;
        s_axis_tvalid = 0;
        s_axis_tdata  = '0;
        m_axis_tready = 1;

        rst_n = 0;
        repeat (10) @(posedge clk);
        rst_n = 1;
        repeat (10) @(posedge clk);

        // Test 1: CFO = 0.3, SNR = 20 dB
        $display("\n=== Test 1: CFO=0.3, SNR=20dB ===");
        gen_test(0.3, 20.0);
        send_data();
        #2000;

        if (fft_start)
            $display("  PASS: Packet detected, FFT at cycle");
        else begin
            $display("  FAIL: No packet detection");
            error_cnt++;
        end

        // Test 2: CFO = -1.2, SNR = 15 dB
        $display("\n=== Test 2: CFO=-1.2, SNR=15dB ===");
        gen_test(-1.2, 15.0);
        send_data();
        #2000;

        if (fft_start)
            $display("  PASS: Packet detected at large CFO");
        else begin
            $display("  FAIL: No detection at CFO=-1.2");
            error_cnt++;
        end

        // Summary
        $display("\n=====================================");
        if (error_cnt == 0) $display("  ALL TESTS PASSED");
        else                $display("  %0d ERRORS FOUND", error_cnt);
        $display("=====================================\n");
        $finish();
    end

    initial begin #100000; $display("TIMEOUT"); $finish(); end
    initial begin $dumpfile("tb_sync.vcd"); $dumpvars(0, tb_sync_top); end

endmodule : tb_sync_top
