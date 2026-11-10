//==============================================================================
// tb_fft64_direction — 方向 (P_DIR) 正确性专项
//
// 为什么单独立一个 TB: tb_fft64_sdf_core 里的冲激/直流/Nyquist 判据对 FFT 与
// IFFT 是**对称**的 —— 输入实且对称时两个方向给出同样的结果, 因此那些判据
// 分辨不出方向符号有没有翻对。golden 侧就是在这里栽过: 只翻了非平凡旋转因子表、
// 漏翻 BF2II 的平凡 ±j, 而当时的测试全绿 (误差被当成量化噪声)。
//
// 判据 (解析可知): 送复数单音 x[n] = A·e^{+j2πn/64}
//   FFT  (e^{-j}): X[k] = Σ e^{j2πn(1-k)/64} -> 能量集中在 bin 1
//   IFFT (e^{+j}): Y[k] = Σ e^{j2πn(1+k)/64} -> 能量集中在 bin 63
// 两者落在不同 bin, 任一方向的符号翻错都会立刻暴露。
//
// 反假绿: 任一判据失败即 $fatal(1)。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_direction;

    localparam int DATA_W = 16;
    localparam int P_W    = 21;
    localparam int AMP    = 2048;     // 8*AMP = 16384 恰好不溢 Q2.14
    // 两个方向的**输出格式不同**, 故同一物理量的整数值差一倍:
    //   FFT  输出 Q2.14 -> 1.0 = 16384, 峰值 8*AMP        = 16384
    //   IFFT 输出 Q3.13 -> 1.0 =  8192, 峰值 8*AMP/2      =  8192
    // 输出级对 IFFT 多做的那次 (x+1)>>>1 是 Q2.14->Q3.13 的**格式转换**,
    // 不是额外缩放 —— 物理值相同, 只是标度不同。拿同一个整数期望值套两个方向
    // 会误判 (实测吃过这个亏: IFFT 报 8190 被当成"少了一半")。
    localparam int PEAK_F = 8 * AMP;        // Q2.14
    localparam int PEAK_R = 8 * AMP / 2;    // Q3.13
    localparam int TOL    = 64;       // 单音量化 + 旋转舍入的容差

    logic i_clk = 1'b0, i_rst = 1'b1, i_beat = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;

    logic f_valid, f_sb, r_valid, r_sb;
    logic [5:0] f_idx, r_idx;
    logic signed [DATA_W-1:0] f_re, f_im, r_re, r_im;

    int errors = 0;
    int mag_f [0:63];
    int mag_r [0:63];
    int cf = 0, cr = 0;

    always #5 i_clk = ~i_clk;

    fft64_sdf_core #(.DATA_W(DATA_W), .P_W(P_W), .P_DIR(1'b0)) dut_fft (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(f_valid), .o_idx(f_idx), .o_re(f_re), .o_im(f_im), .o_sb(f_sb));

    fft64_sdf_core #(.DATA_W(DATA_W), .P_W(P_W), .P_DIR(1'b1)) dut_ifft (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(r_valid), .o_idx(r_idx), .o_re(r_re), .o_im(r_im), .o_sb(r_sb));

    function automatic logic [5:0] bitrev6(input logic [5:0] n);
        bitrev6 = {n[0], n[1], n[2], n[3], n[4], n[5]};
    endfunction

    function automatic int absi(input int v);
        absi = (v < 0) ? -v : v;
    endfunction

    task automatic check(input string what, input bit cond);
        if (!cond) begin
            $display("  [FAIL] %s", what);
            errors = errors + 1;
        end
    endtask

    // 捕获: 以各自的侧带为符号起点, 记 |re|+|im| 作为能量指标
    always @(posedge i_clk) begin
        if (!i_rst) begin
            if (f_valid && f_sb) begin
                mag_f[bitrev6(f_idx)] <= absi(int'(f_re)) + absi(int'(f_im));
                cf <= 1;
            end else if (f_valid && cf > 0 && cf < 64) begin
                mag_f[bitrev6(f_idx)] <= absi(int'(f_re)) + absi(int'(f_im));
                cf <= cf + 1;
            end
            if (r_valid && r_sb) begin
                mag_r[bitrev6(r_idx)] <= absi(int'(r_re)) + absi(int'(r_im));
                cr <= 1;
            end else if (r_valid && cr > 0 && cr < 64) begin
                mag_r[bitrev6(r_idx)] <= absi(int'(r_re)) + absi(int'(r_im));
                cr <= cr + 1;
            end
        end
    end

    // flush 必须是 64 的整数倍, 否则下一符号会从块内偏移处开始
    task automatic feed_tone(input bit tone);
        real th;
        for (int n = 0; n < 64; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1;
            i_sb    = (n == 0);
            if (tone) begin
                th   = 2.0 * 3.14159265358979 * n / 64.0;
                i_re = DATA_W'($rtoi(AMP * $cos(th)));
                i_im = DATA_W'($rtoi(AMP * $sin(th)));
            end else begin
                i_re = '0; i_im = '0;
            end
        end
        for (int n = 0; n < 192; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1; i_sb = 1'b0; i_re = '0; i_im = '0;
        end
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        feed_tone(1'b0);                 // 预热: 冲掉未初始化的 X
        feed_tone(1'b1);                 // 复数单音 e^{+j2πn/64}
        repeat (100) @(negedge i_clk);

        // FFT 方向: 能量应在 bin 1
        check($sformatf("FFT: bin1 能量应≈%0d (Q2.14), 实为 %0d", PEAK_F, mag_f[1]),
              mag_f[1] > PEAK_F - 8*TOL);
        check($sformatf("FFT: bin63 应近 0, 实为 %0d", mag_f[63]), mag_f[63] < TOL);

        // IFFT 方向: 能量应在 bin 63
        check($sformatf("IFFT: bin63 能量应≈%0d (Q3.13), 实为 %0d", PEAK_R, mag_r[63]),
              mag_r[63] > PEAK_R - 8*TOL);
        check($sformatf("IFFT: bin1 应近 0, 实为 %0d", mag_r[1]), mag_r[1] < TOL);

        // 两个方向必须落在不同 bin —— 这条是本 TB 的核心
        check("FFT 与 IFFT 的能量峰不得落在同一 bin (方向未生效)",
              !((mag_f[1] > PEAK_F/2) && (mag_r[1] > PEAK_R/2)));

        // 其余 bin 应无显著能量 (泄漏 < 各自峰值的 5%)
        for (int k = 0; k < 64; k++) begin
            if (k != 1)  check($sformatf("FFT bin%0d 泄漏过大: %0d", k, mag_f[k]),
                               mag_f[k] < PEAK_F/20);
            if (k != 63) check($sformatf("IFFT bin%0d 泄漏过大: %0d", k, mag_r[k]),
                               mag_r[k] < PEAK_R/20);
        end

        if (errors == 0) begin
            $display("RESULT: PASS - tb_fft64_direction, 0 errors (FFT->bin1 / IFFT->bin63, 方向可分辨)");
            $finish;
        end else begin
            $fatal(1, "TB_FAIL: tb_fft64_direction %0d 项判据失败", errors);
        end
    end

endmodule

`default_nettype wire
