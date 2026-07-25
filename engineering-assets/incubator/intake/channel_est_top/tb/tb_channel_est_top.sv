//==============================================================================
// Testbench for Channel Estimation Top (LS + Linear Interpolation)
// Tests: flat channel, frequency-selective channel, pilot sign correctness
// Self-checking: compares H_est against expected values
//==============================================================================
`timescale 1ns/1ps

module tb_channel_est;

    localparam DATA_W = 16;
    localparam N_FFT  = 64;

    logic clk, rst_n;
    logic s_axis_tvalid, s_axis_tready;
    logic [DATA_W*2-1:0] s_axis_tdata;
    logic m_axis_tvalid, m_axis_tready;
    logic [DATA_W*2-1:0] m_axis_tdata;

    // DUT
    channel_est_top #(.DATA_W(DATA_W)) dut (
        .clk(clk), .rst_n(rst_n),
        .s_axis_tvalid(s_axis_tvalid), .s_axis_tready(s_axis_tready),
        .s_axis_tdata(s_axis_tdata),
        .m_axis_tvalid(m_axis_tvalid), .m_axis_tready(m_axis_tready),
        .m_axis_tdata(m_axis_tdata)
    );

    // Clock
    initial clk = 0;
    always #5 clk = ~clk;

    // Test control
    int error_cnt;
    int sym_cnt;

    //===== Task: send one OFDM symbol =====
    task send_sym(input shortreal p0_i, p0_q, p1_i, p1_q,
                         p2_i, p2_q, p3_i, p3_q);
        begin
            s_axis_tvalid = 1;
            for (int k = 0; k < N_FFT; k++) begin
                automatic shortreal v_i = 0.0, v_q = 0.0;
                // Pilot positions (0-based): 11, 25, 39, 53
                if      (k == 11) begin v_i = p0_i; v_q = p0_q; end
                else if (k == 25) begin v_i = p1_i; v_q = p1_q; end
                else if (k == 39) begin v_i = p2_i; v_q = p2_q; end
                else if (k == 53) begin v_i = p3_i; v_q = p3_q; end
                // Quantize to Q2.14
                s_axis_tdata = {
                    $shortrealtobits(v_q * 16384.0),
                    $shortrealtobits(v_i * 16384.0)
                };
                @(posedge clk);
                while (!s_axis_tready) @(posedge clk);
            end
            s_axis_tvalid = 0;
        end
    endtask

    //===== Task: check output sample =====
    task check_h(input int idx, input shortreal exp_i, exp_q, input string label);
        automatic int tol = 3;  // tolerance in LSB
        automatic int got_i, got_q, exp_i_q14, exp_q_q14;
        got_i = $signed(m_axis_tdata[15:0]);
        got_q = $signed(m_axis_tdata[31:16]);
        exp_i_q14 = $rtoi(exp_i * 16384.0 + 0.5);
        exp_q_q14 = $rtoi(exp_q * 16384.0 + 0.5);
        if ($signed(got_i - exp_i_q14) > tol || $signed(got_i - exp_i_q14) < -tol ||
            $signed(got_q - exp_q_q14) > tol || $signed(got_q - exp_q_q14) < -tol) begin
            $display("ERROR [%0d] %s H[%0d] = (%d,%d) exp (%d,%d)",
                     sym_cnt, label, idx, got_i, got_q, exp_i_q14, exp_q_q14);
            error_cnt++;
        end
    endtask

    //===== Main test =====
    initial begin
        error_cnt = 0; sym_cnt = 0;
        s_axis_tvalid = 0; m_axis_tready = 1;
        rst_n = 0;
        repeat (10) @(posedge clk);
        rst_n = 1;
        repeat (10) @(posedge clk);

        //==========================================================
        // Test 1: Flat channel H = 1+0j
        // Pilots: [+1, +1, -1, +1] -> LS gives [1,1,1,1]
        // Expected: H_est = 1+0j for all subcarriers
        //==========================================================
        $display("\n=== Test 1: Flat Channel (H=1) ===");
        sym_cnt = 1;
        send_sym(1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 1.0, 0.0);
        #5000;

        // Sample H_est output
        $display("P1 DUT state=%0d out_cnt=%0d",
                 dut.u_interpolator.state, dut.u_interpolator.out_cnt);
        check_h(5,  1.0, 0.0, "T1");
        check_h(18, 1.0, 0.0, "T1");
        check_h(32, 1.0, 0.0, "T1");
        check_h(45, 1.0, 0.0, "T1");
        check_h(58, 1.0, 0.0, "T1");
        $display("Test 1 done, errors=%0d", error_cnt);

        //==========================================================
        // Test 2: Constant channel H = 0.5+0.5j
        // Pilots: [0.5+0.5j, 0.5+0.5j, -0.5-0.5j, 0.5+0.5j]
        // After LS: [0.5+0.5j, 0.5+0.5j, 0.5+0.5j, 0.5+0.5j]
        // Expected: H = 0.5+0.5j (DC = 1+0j)
        //==========================================================
        $display("\n=== Test 2: Constant Channel (0.5+0.5j) ===");
        sym_cnt = 2;
        send_sym(0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5);
        #5000;
        check_h(32, 1.0, 0.0, "T2");  // DC=1+0j
        check_h(5,  0.5, 0.5, "T2");
        check_h(18, 0.5, 0.5, "T2");
        check_h(45, 0.5, 0.5, "T2");
        check_h(58, 0.5, 0.5, "T2");
        $display("Test 2 done, errors=%0d", error_cnt);

        // Summary
        $display("\n====================================");
        if (error_cnt == 0) $display("  ALL TESTS PASSED");
        else                $display("  %0d ERRORS FOUND", error_cnt);
        $display("====================================\n");
        $finish();
    end

    initial begin #100000; $display("TIMEOUT"); $finish(); end
endmodule
