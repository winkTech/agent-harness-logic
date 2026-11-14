//==============================================================================
// tb_cp_remove — 802.11a 帧结构切窗自检 TB
//
// 判据全部解析可知 (纯选通逻辑, 无算术, 不存在容差空间 —— 逐样点相等):
//   1. 切窗序列: i_fft_start 起 T1(取64) -> T2(取64) -> {跳16 取64} x n_sym
//      样点值编码为其在输入流中的下标, 故任何错位都能直接读出偏了多少。
//   2. 帧尾: 数完 i_cfg_n_sym 个数据符号即回 UNSYNC, 其后不得再吐。
//   3. 侧带: o_sb 只在 LTS1 首拍打一次 (供 fft64 透传给 channel_est_top)。
//   4. UNSYNC 期间 (fft_start 之前) 不得有任何输出。
//   5. 帧中途复位 -> 回 UNSYNC, 新的 fft_start 能重新起窗。
//
// 帧结构 (取自 models/comm/synch/config.m, 该 golden 引 IEEE 802.11a-1999 §17.3.3):
//   GI2=32 由 sync_top 在上游消化, 本模块从 T1 首样点开始; T1=T2=64 且不带 CP;
//   数据符号 = CP(16) + 64。
//
// 反假绿: 任一判据失败即 $fatal(1)。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_cp_remove;

    localparam int DATA_W = 16;
    localparam int N      = 64;
    localparam int N_CP   = 16;
    localparam int NSYM   = 5;        // 数据符号数
    localparam int LEAD   = 37;       // fft_start 之前的残留 (长度任取)

    logic i_clk = 1'b0, i_rst = 1'b1;
    logic i_fft_start = 1'b0;
    logic [7:0] i_cfg_n_sym = NSYM;
    logic s_valid = 1'b0;
    logic [DATA_W*2-1:0] s_data = '0;

    logic o_valid, o_sb;
    logic signed [DATA_W-1:0] o_re, o_im;

    int errors = 0;
    int got_n = 0;
    int got_re [0:1023];
    int sb_pos = -1;
    int sb_cnt = 0;
    int exp_v, got_v;

    always #5 i_clk = ~i_clk;

    cp_remove #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_fft_start(i_fft_start), .i_cfg_n_sym(i_cfg_n_sym),
        .s_axis_tvalid(s_valid), .s_axis_tdata(s_data),
        .o_valid(o_valid), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    task automatic check(input string what, input bit cond);
        if (!cond) begin
            $display("  [FAIL] %s", what);
            errors = errors + 1;
        end
    endtask

    always @(posedge i_clk) begin
        if (!i_rst && o_valid) begin
            if (got_n < 1024) got_re[got_n] <= int'(o_re);
            if (o_sb) begin
                if (sb_pos < 0) sb_pos <= got_n;
                sb_cnt <= sb_cnt + 1;
            end
            got_n <= got_n + 1;
        end
    end

    // 送一拍: 样点实部 = 其在输入流中的下标 (虚部取负, 便于查 I/Q 是否错位)
    task automatic beat(input int idx, input bit fs);
        @(negedge i_clk);
        s_valid     = 1'b1;
        i_fft_start = fs;
        s_data      = {DATA_W'(-idx), DATA_W'(idx)};   // {Q, I}
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // ---- 送流: [LEAD][T1][T2]{[CP16][DATA64]} x NSYM [尾部若干] ----
        for (int n = 0; n < LEAD; n++)                 beat(n, 1'b0);
        // fft_start 与 T1 首样点同拍
        for (int n = 0; n < 2*N; n++)                  beat(LEAD + n, (n == 0));
        for (int k = 0; k < NSYM; k++)
            for (int n = 0; n < N_CP + N; n++)         beat(LEAD + 2*N + k*(N_CP+N) + n, 1'b0);
        for (int n = 0; n < 100; n++)                  beat(9000 + n, 1'b0);
        @(negedge i_clk); s_valid = 1'b0; i_fft_start = 1'b0;
        repeat (20) @(negedge i_clk);

        // ---- 1. 总点数: (2 + NSYM) 个切窗符号 + 64 拍帧尾冲刷 ----
        check($sformatf("应输出 %0d 点 (切窗 %0d + 冲刷 %0d), 实为 %0d",
                        (2+NSYM)*N + N, (2+NSYM)*N, N, got_n),
              got_n == (2+NSYM)*N + N);

        // ---- 2. T1/T2 逐样点: 不跳 CP, 紧接 fft_start ----
        for (int n = 0; n < 2*N; n++)
            check($sformatf("LTS 第 %0d 点应为 %0d, 实为 %0d", n, LEAD+n, got_re[n]),
                  got_re[n] == LEAD + n);

        // ---- 3. 数据符号逐样点: 每个先跳 16 再取 64 ----
        for (int k = 0; k < NSYM; k++)
            for (int n = 0; n < N; n++) begin
                exp_v = LEAD + 2*N + k*(N_CP+N) + N_CP + n;
                got_v = got_re[2*N + k*N + n];
                check($sformatf("符号%0d 第 %0d 点应为 %0d, 实为 %0d", k, n, exp_v, got_v),
                      got_v == exp_v);
            end

        // ---- 3b. 帧尾冲刷: 恰好 64 拍, 每拍必须是**零** ----
        // 这 64 拍不是切窗结果, 是为 fft64_sdf 排空流水而补的 (见模块头)。
        // 它们不进 golden 的切窗判据, 所以必须在这里逐拍钉死, 否则就是没人管的 64 点。
        for (int n = 0; n < N; n++) begin
            got_v = got_re[(2+NSYM)*N + n];
            check($sformatf("冲刷第 %0d 拍应为 0, 实为 %0d", n, got_v), got_v == 0);
        end

        // ---- 4. 侧带: 只在 LTS1 首拍打一次 ----
        check($sformatf("侧带应落在第 0 个输出, 实为第 %0d", sb_pos), sb_pos == 0);
        check($sformatf("侧带应只打一次, 实为 %0d 次", sb_cnt), sb_cnt == 1);

        // ---- 5. 帧中途复位 -> 回 UNSYNC, 新 fft_start 能重新起窗 ----
        got_n = 0; sb_pos = -1; sb_cnt = 0;
        i_rst = 1'b1; repeat (4) @(negedge i_clk); i_rst = 1'b0;
        for (int n = 0; n < 20; n++) beat(n, 1'b0);          // 复位后无 fft_start
        check("复位后未见 fft_start 时不得有输出", got_n == 0);
        for (int n = 0; n < 2*N; n++) beat(500 + n, (n == 0));
        for (int n = 0; n < N_CP + N; n++) beat(700 + n, 1'b0);
        @(negedge i_clk); s_valid = 1'b0;
        repeat (20) @(negedge i_clk);
        check($sformatf("复位重入后应输出 %0d 点, 实为 %0d", 3*N, got_n), got_n == 3*N);
        check("复位重入后 LTS1 首点应为 500", got_re[0] == 500);

        if (errors == 0) begin
            $display("RESULT: PASS - tb_cp_remove, 0 errors (切窗/帧尾/侧带/复位重入 全部通过)");
            $finish;
        end else begin
            $fatal(1, "TB_FAIL: tb_cp_remove %0d 项判据失败", errors);
        end
    end

endmodule

`default_nettype wire
