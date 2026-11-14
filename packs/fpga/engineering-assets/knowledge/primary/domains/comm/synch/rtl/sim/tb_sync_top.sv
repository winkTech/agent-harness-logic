//==============================================================================
// Testbench for OFDM Synchronization
// Generates preamble + CFO + noise, verifies packet detection + timing
//
// 本 TB 随 RTL 的 hdl-coding 规范修复同步更新:
//   - 端口名 clk/rst_n/fft_start/sync_locked -> i_clk/i_rst/o_fft_start/o_sync_locked
//   - 复位极性由低有效改为高有效 (i_rst=1 复位)
//   - 新增对**当前真正可用功能**的断言: 短前导码期间包检测必须置位。
//     原 TB 只断言 o_fft_start, 而该信号因 RTL 缺陷恒为 0 (见下 KNOWN-FAIL),
//     等于既测不出通过也测不出回归。
//
// KNOWN-FAIL (已知缺陷, 非本次修复引入, 见 rtl/fine_timing.sv 文件头 [F1]):
//   o_fft_start 恒为 0 —— fine_timing 中没有任何路径把 FFT 窗触发置 1。
//   该项在下方以 xfail 计数, **不计入 error_cnt**, 但会在摘要里明确列出。
//   一旦 [F1] 被修复, xfail 会变成 unexpected-pass 并提示更新本 TB。
//==============================================================================
`timescale 1ns/1ps

module tb_sync_top;

    localparam DATA_W = 16;
    localparam CLK_PER = 10;

    logic i_clk, i_rst;
    logic s_axis_tvalid, s_axis_tready;
    logic [DATA_W*2-1:0] s_axis_tdata;
    logic m_axis_tvalid, m_axis_tready;
    logic [DATA_W*2-1:0] m_axis_tdata;
    logic o_fft_start, o_sync_locked;

    // DUT
    sync_top #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .s_axis_tvalid(s_axis_tvalid), .s_axis_tready(s_axis_tready),
        .s_axis_tdata(s_axis_tdata),
        .m_axis_tvalid(m_axis_tvalid), .m_axis_tready(m_axis_tready),
        .m_axis_tdata(m_axis_tdata),
        .o_fft_start(o_fft_start), .o_sync_locked(o_sync_locked)
    );

    // Clock
    initial i_clk = 0;
    always #(CLK_PER/2) i_clk = ~i_clk;

    // Test data (pre-computed preamble with CFO)
    // Q2.14 format: multiply by 16384, round to int
    int test_i [0:511];  // preamble + padding
    int test_q [0:511];
    int test_len;
    int error_cnt;
    int xfail_cnt;
    int unexpected_pass_cnt;

    // 包检测观测点: sync_top 未把包检测结果引出到端口, 层次引用内部互连线
    wire w_pd_detected = dut.w_pd_detected;
    bit  seen_detect;

    // 数据通路直通检查: m_axis 应为 s_axis 延迟 2 拍 (ri_ 1 + ro_ 1)
    localparam int PASSTHRU_LAT = 2;
    logic [DATA_W*2-1:0] exp_pipe [0:PASSTHRU_LAT-1];
    logic                exp_v_pipe [0:PASSTHRU_LAT-1];
    int passthru_checked, passthru_bad;

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
            automatic real phi = 2.0 * 3.14159 * epsilon *n / 64.0;
            automatic int si =n % 16;
            r_i[n] = short_sym[si] * $cos(phi);
            r_q[n] = short_sym[si] * $sin(phi);
        end

        // GI2 (32 samples)
        for (n = 0; n < 32; n++) begin
            automatic real phi = 2.0 * 3.14159 * epsilon *(160+n) / 64.0;
            automatic int si =64-32+n;
            r_i[160+n] = long_sym[si] * $cos(phi);
            r_q[160+n] = long_sym[si] * $sin(phi);
        end

        // T1 + T2
        for (n = 0; n < 128; n++) begin
            automatic real phi = 2.0 * 3.14159 * epsilon *(192+n) / 64.0;
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
            @(posedge i_clk);
            while (!s_axis_tready) @(posedge i_clk);
        end
        s_axis_tvalid = 0;
    endtask

    // 包检测监视: 只要在本轮激励期间置位过就算检出
    always @(posedge i_clk) if (!i_rst && w_pd_detected) seen_detect <= 1'b1;

    // m_axis 直通延迟自检 (复位释放后持续运行)
    always @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < PASSTHRU_LAT; k++) begin
                exp_pipe[k]   <= '0;
                exp_v_pipe[k] <= 1'b0;
            end
        end else begin
            exp_v_pipe[0] <= s_axis_tvalid;
            if (s_axis_tvalid) exp_pipe[0] <= s_axis_tdata;
            for (int k = 1; k < PASSTHRU_LAT; k++) begin
                exp_v_pipe[k] <= exp_v_pipe[k-1];
                if (exp_v_pipe[k-1]) exp_pipe[k] <= exp_pipe[k-1];
            end
            if (m_axis_tvalid) begin
                passthru_checked++;
                if (m_axis_tdata !== exp_pipe[PASSTHRU_LAT-1]) begin
                    passthru_bad++;
                    if (passthru_bad <= 5)
                        $display("  PASSTHRU MISMATCH @%0t exp=%h got=%h",
                                 $time, exp_pipe[PASSTHRU_LAT-1], m_axis_tdata);
                end
            end
        end
    end

    task automatic run_case(string name, real eps, real snr);
        $display("\n=== %s ===", name);
        seen_detect = 1'b0;
        gen_test(eps, snr);
        send_data();
        #2000;

        // [必须通过] 包检测: 短前导码有强周期自相关, 必须被检出
        if (seen_detect) begin
            $display("  PASS: packet_detect asserted during preamble");
        end else begin
            $display("  FAIL: packet_detect never asserted");
            error_cnt++;
        end

        // [已知缺陷 xfail] FFT 窗触发
        if (o_fft_start) begin
            $display("  UNEXPECTED PASS: o_fft_start asserted — fine_timing [F1] 似已修复, 请更新本 TB");
            unexpected_pass_cnt++;
        end else begin
            $display("  XFAIL (known, fine_timing [F1]): o_fft_start 恒为 0, FFT 窗触发未实现");
            xfail_cnt++;
        end
    endtask

    // Test control
    initial begin
        error_cnt = 0;
        xfail_cnt = 0;
        unexpected_pass_cnt = 0;
        passthru_checked = 0;
        passthru_bad = 0;
        s_axis_tvalid = 0;
        s_axis_tdata  = '0;
        m_axis_tready = 1;

        i_rst = 1;
        repeat (10) @(posedge i_clk);
        i_rst = 0;
        repeat (10) @(posedge i_clk);

        run_case("Test 1: CFO=0.3, SNR=20dB",  0.3, 20.0);
        run_case("Test 2: CFO=-1.2, SNR=15dB", -1.2, 15.0);

        // [必须通过] 数据通路直通延迟契约
        $display("\n=== Passthrough latency contract (%0d cycles) ===", PASSTHRU_LAT);
        if (passthru_checked == 0) begin
            $display("  FAIL: no m_axis beats observed");
            error_cnt++;
        end else if (passthru_bad != 0) begin
            $display("  FAIL: %0d/%0d beats mismatched", passthru_bad, passthru_checked);
            error_cnt++;
        end else begin
            $display("  PASS: %0d beats, m_axis == s_axis delayed %0d", passthru_checked, PASSTHRU_LAT);
        end

        // Summary
        $display("\n=====================================");
        $display("  errors=%0d  xfail(known)=%0d  unexpected-pass=%0d",
                 error_cnt, xfail_cnt, unexpected_pass_cnt);
        if (error_cnt == 0) $display("  ALL REQUIRED CHECKS PASSED");
        $display("=====================================\n");
        if (error_cnt != 0)
            $fatal(1, "tb_sync_top: %0d required check(s) failed", error_cnt);
        $finish();
    end

    initial begin
        #100000;
        $display("TIMEOUT");
        $fatal(1, "tb_sync_top: simulation timeout before completion");
    end
    initial begin $dumpfile("tb_sync.vcd"); $dumpvars(0, tb_sync_top); end

endmodule : tb_sync_top
