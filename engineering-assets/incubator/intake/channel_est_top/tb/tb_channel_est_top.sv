//==============================================================================
// Testbench for Channel Estimation Top (LS + Linear Interpolation)
// Tests: flat channel, constant complex channel, pilot sign correctness
// Self-checking: compares H_est against expected values
//
// 2026-07-28 随 RTL hdl-coding 规范整改同步更新:
//   - 端口 clk/rst_n -> i_clk/i_rst, 复位改同步高有效;
//   - 层次引用 dut.u_interpolator.state/out_cnt -> r_state/r_out_cnt;
//   - **修正激励量化 bug**: 原用 $shortrealtobits(v*16384.0) 生成"Q2.14"数据 ——
//     该系统函数返回的是 IEEE-754 单精度的**位模式**, 不是定点整数, 送进 DUT
//     的是完全无意义的比特。check_h 侧却按 Q2.14 整数解释, 于是本 TB 此前
//     测的是"垃圾输入 -> 垃圾输出"。现改为 $rtoi(v*16384.0) 取整。
//   - 补 $fatal: 原实现失败也 $finish 退出 0, 上游读不出失败。
//   - 输出采样改为按 m_axis_tvalid 握手捕获整符号后再比对 —— 原实现用 #5000
//     裸延时后直接读 m_axis_tdata, 取到的是流结束后的残留值, 与 idx 参数无关
//     (check_h 的 idx 从未真正参与索引)。
//==============================================================================
`timescale 1ns/1ps

module tb_channel_est;

    localparam DATA_W = 16;
    localparam N_FFT  = 64;

    logic clk, rst;
    logic s_axis_tvalid, s_axis_tready;
    logic [DATA_W*2-1:0] s_axis_tdata;
    logic m_axis_tvalid, m_axis_tready;
    logic [DATA_W*2-1:0] m_axis_tdata;

    // DUT
    channel_est_top #(.DATA_W(DATA_W)) dut (
        .i_clk(clk), .i_rst(rst),
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

    // 输出捕获: 按握手收下整个符号
    logic [DATA_W*2-1:0] cap [0:N_FFT-1];
    int  cap_cnt;
    bit  capturing;

    always @(posedge clk) begin
        if (rst) begin
            cap_cnt <= 0;
        end else if (capturing && m_axis_tvalid && m_axis_tready) begin
            if (cap_cnt < N_FFT) cap[cap_cnt] <= m_axis_tdata;
            cap_cnt <= cap_cnt + 1;
        end
    end

    //===== Task: send one OFDM symbol =====
    task send_sym(input real p0_i, p0_q, p1_i, p1_q,
                             p2_i, p2_q, p3_i, p3_q);
        begin
            s_axis_tvalid = 1;
            for (int k = 0; k < N_FFT; k++) begin
                automatic real v_i = 0.0;
                automatic real v_q = 0.0;
                // Pilot positions (0-based): 11, 25, 39, 53
                if      (k == 11) begin v_i = p0_i; v_q = p0_q; end
                else if (k == 25) begin v_i = p1_i; v_q = p1_q; end
                else if (k == 39) begin v_i = p2_i; v_q = p2_q; end
                else if (k == 53) begin v_i = p3_i; v_q = p3_q; end
                // Quantize to Q2.14 (整数定点, 不是浮点位模式)
                s_axis_tdata = { q14(v_q), q14(v_i) };
                @(posedge clk);
                while (!s_axis_tready) @(posedge clk);
            end
            s_axis_tvalid = 0;
        end
    endtask

    function automatic logic [15:0] q14(input real v);
        int t;
        t = $rtoi(v * 16384.0 + (v >= 0.0 ? 0.5 : -0.5));
        if (t >  32767) t =  32767;
        if (t < -32768) t = -32768;
        return t[15:0];
    endfunction

    //===== Task: check one captured subcarrier =====
    task automatic check_h(input int idx, input real exp_i, exp_q, input string label);
        automatic int tol = 3;  // tolerance in LSB
        automatic int got_i, got_q, exp_i_q14, exp_q_q14;
        if (idx >= cap_cnt || idx >= N_FFT) begin
            $display("ERROR [%0d] %s H[%0d] 未捕获 (仅收到 %0d 个样点)",
                     sym_cnt, label, idx, cap_cnt);
            error_cnt++;
            return;
        end
        got_i = $signed(cap[idx][15:0]);
        got_q = $signed(cap[idx][31:16]);
        exp_i_q14 = $rtoi(exp_i * 16384.0 + 0.5);
        exp_q_q14 = $rtoi(exp_q * 16384.0 + 0.5);
        if ((got_i - exp_i_q14) > tol || (got_i - exp_i_q14) < -tol ||
            (got_q - exp_q_q14) > tol || (got_q - exp_q_q14) < -tol) begin
            $display("ERROR [%0d] %s H[%0d] = (%0d,%0d) exp (%0d,%0d)",
                     sym_cnt, label, idx, got_i, got_q, exp_i_q14, exp_q_q14);
            error_cnt++;
        end
    endtask

    task automatic run_symbol(input real p0_i, p0_q, p1_i, p1_q, p2_i, p2_q, p3_i, p3_q);
        cap_cnt  = 0;
        capturing = 1;
        send_sym(p0_i, p0_q, p1_i, p1_q, p2_i, p2_q, p3_i, p3_q);
        // 等插值输出流完整走完 (或超时)
        begin
            automatic int guard = 0;
            while (cap_cnt < N_FFT && guard < 20000) begin
                @(posedge clk);
                guard++;
            end
        end
        capturing = 0;
        $display("  捕获 %0d / %0d 个子载波", cap_cnt, N_FFT);
    endtask

    //===== Main test =====
    initial begin
        error_cnt = 0; sym_cnt = 0; cap_cnt = 0; capturing = 0;
        s_axis_tvalid = 0; m_axis_tready = 1;
        rst = 1;
        repeat (10) @(posedge clk);
        rst = 0;
        repeat (10) @(posedge clk);

        //==========================================================
        // Test 1: Flat channel H = 1+0j
        // Pilots: [+1, +1, -1, +1] -> LS gives [1,1,1,1]
        // Expected: H_est = 1+0j for all subcarriers
        //==========================================================
        $display("\n=== Test 1: Flat Channel (H=1) ===");
        sym_cnt = 1;
        run_symbol(1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 1.0, 0.0);
        $display("  DUT interp state=%0d out_cnt=%0d",
                 dut.u_interpolator.r_state, dut.u_interpolator.r_out_cnt);
        check_h(5,  1.0, 0.0, "T1");
        check_h(18, 1.0, 0.0, "T1");
        check_h(32, 1.0, 0.0, "T1");
        check_h(45, 1.0, 0.0, "T1");
        check_h(58, 1.0, 0.0, "T1");
        $display("Test 1 done, errors=%0d", error_cnt);

        //==========================================================
        // Test 2: Constant channel H = 0.5+0.5j
        //==========================================================
        $display("\n=== Test 2: Constant Channel (0.5+0.5j) ===");
        sym_cnt = 2;
        run_symbol(0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5);
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
        if (error_cnt != 0)
            $fatal(1, "tb_channel_est: %0d check(s) failed", error_cnt);
        $finish();
    end

    initial begin
        #200000;
        $display("TIMEOUT");
        $fatal(1, "tb_channel_est: simulation timeout before completion");
    end
endmodule
