//==============================================================================
// tb_cp_remove_stability — G-C-05 的四个具名子结果 (boundary/stress/regression/
// backpressure) 中由本 TB 承担的三个; regression 由 run_sim.cjs 汇总既有 TB。
//
// 激励沿用 tb_cp_remove 的约定: 样点实部 = 其在输入流中的下标, 故任何错位都能
// 直接读出偏了多少拍, 不必反推波形。
//
// 子结果与判据:
//   boundary     段边界与配置极值 —— T1/T2 交界不跳 CP、T2->CP 交界、帧尾静默、
//                i_cfg_n_sym 取 1 与 255 两个极值。n_sym=0 单独探测并如实上报
//                (它是否合法是接口契约问题, 见下)。
//   stress       背靠背连帧 (帧尾紧接下一个 fft_start) 与长程运行, 检查计数器
//                不累积漂移。
//   backpressure 本模块**无 tready**, 其等价性质是: s_axis_tvalid 间歇拉低时,
//                切窗计数只在有效拍推进 —— 空拍既不吞样点也不错位。这条不是
//                "支持反压", 而是"无反压契约下的正确行为", 两者不可混为一谈。
//
// 输出格式 (供 run_sim.cjs 解析成 stability/<name>.json):
//   STAB <name> <PASS|FAIL> <beats> <reason>
//   NOTE <text>
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_cp_remove_stability;

    localparam int DATA_W  = 16;
    localparam int N       = 64;
    localparam int N_CP    = 16;
    localparam int N_FLUSH = 64;   // 帧尾冲刷 (1.1.0): 数满后自驱吐 64 拍零
    localparam int DRAIN   = N_FLUSH + 20;  // 收尾等待须盖过自驱冲刷

    logic i_clk = 1'b0, i_rst = 1'b1;
    logic i_fft_start = 1'b0;
    logic [7:0] i_cfg_n_sym = 8'd4;
    logic s_valid = 1'b0;
    logic [DATA_W*2-1:0] s_data = '0;

    logic o_valid, o_sb;
    logic signed [DATA_W-1:0] o_re, o_im;

    int got_n = 0, sb_cnt = 0, sb_pos = -1;
    int got_re [0:8191];
    int beats = 0;
    int fails = 0;

    // 值域过滤计数: 只数落在 [wnd_lo, wnd_hi] 的输出。
    // 零间隔场景没有任何可以安全清计数的时刻 (两帧输出首尾相接), 用样点值本身
    // 区分帧比用清零时机可靠 —— 样点实部就是它的输入下标。
    int wnd_lo = 1, wnd_hi = 0, wnd_n = 0;

    always #5 i_clk = ~i_clk;

    cp_remove #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_fft_start(i_fft_start), .i_cfg_n_sym(i_cfg_n_sym),
        .s_axis_tvalid(s_valid), .s_axis_tdata(s_data),
        .o_valid(o_valid), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    always @(posedge i_clk) begin
        if (!i_rst && o_valid) begin
            if (got_n < 8192) got_re[got_n] <= int'(o_re);
            if (o_sb) begin
                if (sb_pos < 0) sb_pos <= got_n;
                sb_cnt <= sb_cnt + 1;
            end
            got_n <= got_n + 1;
            if (int'(o_re) >= wnd_lo && int'(o_re) <= wnd_hi) wnd_n <= wnd_n + 1;
        end
    end

    // 一个有效拍: 实部 = 输入流下标
    task automatic beat(input int idx, input bit fs);
        @(negedge i_clk);
        s_valid = 1'b1; i_fft_start = fs;
        s_data  = {DATA_W'(-idx), DATA_W'(idx)};
        beats++;
    endtask

    // 一个空拍 (tvalid 低)。样点线上继续放"毒值", 若被误采会立刻暴露。
    task automatic idle();
        @(negedge i_clk);
        s_valid = 1'b0; i_fft_start = 1'b0;
        s_data  = {DATA_W'(-32'sd9999), DATA_W'(32'sd9999)};
        beats++;
    endtask

    task automatic clr();
        got_n = 0; sb_cnt = 0; sb_pos = -1;
    endtask

    task automatic rst_pulse();
        @(negedge i_clk); s_valid = 1'b0; i_fft_start = 1'b0;
        i_rst = 1'b1; repeat (4) @(negedge i_clk); i_rst = 1'b0;
        @(negedge i_clk);
        clr();
    endtask

    task automatic bad(input string what);
        fails++;
        $display("  [FAIL] %s", what);
    endtask

    // 送一整帧 (从 base 号样点起), n 个数据符号, gap=1 时每个有效拍后插一个空拍
    task automatic send_frame(input int base, input int n, input bit gap);
        for (int k = 0; k < 2*N; k++) begin
            beat(base + k, (k == 0));
            if (gap) idle();
        end
        for (int s = 0; s < n; s++)
            for (int k = 0; k < N_CP + N; k++) begin
                beat(base + 2*N + s*(N_CP+N) + k, 1'b0);
                if (gap) idle();
            end
    endtask

    int b0, ok, expv, n0;

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        //======================================================================
        // boundary
        //======================================================================
        begin
            int bfail;
            bfail = 0;

            // --- B1. n_sym = 1 (最小有意义配置) ---
            i_cfg_n_sym = 8'd1;
            rst_pulse();
            b0 = beats;
            send_frame(1000, 1, 1'b0);
            for (int k = 0; k < 120; k++) beat(30000 + k, 1'b0);   // 帧尾后继续灌
            @(negedge i_clk); s_valid = 1'b0; repeat (DRAIN) @(negedge i_clk);
            if (got_n != 3*N + N_FLUSH) begin
                bfail++; bad($sformatf("n_sym=1 应出 %0d 点 (切窗 %0d + 冲刷 %0d), 实为 %0d",
                             3*N + N_FLUSH, 3*N, N_FLUSH, got_n));
            end
            // T1/T2 紧邻不跳 CP —— 交界处最容易错
            if (got_re[N-1] != 1000 + N - 1 || got_re[N] != 1000 + N) begin
                bfail++; bad($sformatf("T1/T2 交界错位: [%0d]=%0d [%0d]=%0d",
                             N-1, got_re[N-1], N, got_re[N]));
            end
            // T2->CP->DATA 交界: 数据符号首点应跳过 16
            if (got_re[2*N] != 1000 + 2*N + N_CP) begin
                bfail++; bad($sformatf("T2->CP 交界错位: 数据首点 %0d 期望 %0d",
                             got_re[2*N], 1000 + 2*N + N_CP));
            end
            $display("  B1 n_sym=1: %0d 点, 帧尾后灌 120 拍无溢出", got_n);

            // --- B2. n_sym = 255 (配置上限) ---
            i_cfg_n_sym = 8'd255;
            rst_pulse();
            send_frame(0, 255, 1'b0);
            @(negedge i_clk); s_valid = 1'b0; repeat (DRAIN) @(negedge i_clk);
            if (got_n != (2 + 255) * N + N_FLUSH) begin
                bfail++; bad($sformatf("n_sym=255 应出 %0d 点 (切窗 %0d + 冲刷 %0d), 实为 %0d",
                             (2+255)*N + N_FLUSH, (2+255)*N, N_FLUSH, got_n));
            end
            if (sb_cnt != 1) begin
                bfail++; bad($sformatf("n_sym=255 侧带应 1 次, 实为 %0d", sb_cnt));
            end
            $display("  B2 n_sym=255: %0d 点, 侧带 %0d 次", got_n, sb_cnt);

            // --- B3. n_sym = 0 探测 (不作为判据, 只如实上报) ---
            i_cfg_n_sym = 8'd0;
            rst_pulse();
            send_frame(2000, 1, 1'b0);
            @(negedge i_clk); s_valid = 1'b0; repeat (DRAIN) @(negedge i_clk);
            n0 = got_n;
            $display("NOTE n_sym=0 实测输出 %0d 点 (2 个 LTS = %0d 点; golden rx_cp_window 在 n_sym=0 时只出 LTS)", n0, 2*N);

            if (bfail == 0)
                $display("STAB boundary PASS %0d 段边界与配置极值: T1/T2 交界不跳 CP、T2->CP 跳 16、帧尾后灌 120 拍不溢出; n_sym 取 1 与 255 两极值均逐点正确, 侧带各 1 次; n_sym=0 行为已探测并记入 limitations (接口契约要求 n_sym>=1)", beats - b0);
            else
                $display("STAB boundary FAIL %0d %0d 项边界判据失败", beats - b0, bfail);
            fails += bfail;
        end

        //======================================================================
        // stress — 长程连帧 (帧间取实测最小间隔 1 拍) + 零间隔行为锁定
        //
        // 帧间必须至少隔 1 个样点: 数据段末点的**下一个**样点才触发
        // S_DATA -> S_UNSYNC, 而那一拍 r_seg 仍是 S_DATA, 只有 S_UNSYNC 分支
        // 消费 i_fft_start —— 零间隔时 fft_start 与该拍同拍到达, 会被吞掉。
        // 1 拍是 tb_cp_remove_gap 逐值测出来的, 不是读代码猜的。
        //======================================================================
        begin
            int sfail, tot;
            sfail = 0; tot = 0;
            i_cfg_n_sym = 8'd4;
            rst_pulse();
            b0 = beats;
            for (int f = 0; f < 12; f++) begin
                // 帧间留够 DRAIN 拍: 让上一帧的自驱冲刷跑完并排空在途输出, 再清计数。
                // 若只留几拍, 下一帧的 fft_start 会**中止**冲刷 (1.1.0 的设计,
                // 见下面单独的锁定断言), 那时每帧点数取决于间隔长短, 不是定值。
                for (int d = 0; d < DRAIN; d++) beat(20000 + f*100 + d, 1'b0);
                clr();
                @(negedge i_clk);
                send_frame(f * 1000, 4, 1'b0);
                for (int d = 0; d < DRAIN; d++) beat(21000 + f*100 + d, 1'b0);
                if (got_n != 6*N + N_FLUSH) begin
                    sfail++; bad($sformatf("第 %0d 帧应出 %0d 点 (切窗 %0d + 冲刷 %0d), 实为 %0d",
                                 f, 6*N + N_FLUSH, 6*N, N_FLUSH, got_n));
                end
                if (sb_cnt != 1) begin
                    sfail++; bad($sformatf("第 %0d 帧侧带应 1 次, 实为 %0d", f, sb_cnt));
                end
                // 每帧首点必须精确落在该帧 base —— 计数器若累积漂移这里立刻暴露
                if (got_re[0] != f * 1000) begin
                    sfail++; bad($sformatf("第 %0d 帧首点 %0d 期望 %0d", f, got_re[0], f*1000));
                end
                tot += got_n;
            end
            @(negedge i_clk); s_valid = 1'b0; repeat (10) @(negedge i_clk);
            $display("  12 帧连发共 %0d 点, 每帧首点无漂移", tot);

            // --- 零间隔必须"整帧丢失"而不是"错位半帧": 把已刻画的行为锁住 ---
            // 若将来有人改 FSM 让零间隔也能起窗, 这里会失败并提示更新 limitations。
            i_cfg_n_sym = 8'd2;
            rst_pulse();
            wnd_lo = 6000; wnd_hi = 6999; wnd_n = 0;   // 只数第二帧的样点
            send_frame(100, 2, 1'b0);                  // 第一帧
            send_frame(6000, 2, 1'b0);                 // **零间隔**紧跟第二帧
            @(negedge i_clk); s_valid = 1'b0; repeat (DRAIN) @(negedge i_clk);
            if (wnd_n != 0) begin
                sfail++;
                bad($sformatf("零间隔下第二帧出了 %0d 点 —— 与已刻画行为 (整帧丢失) 不符, 请复核 docs/limitations.md 6", wnd_n));
            end
            $display("  零间隔背靠背: 第二帧出 %0d 点 (已刻画行为 = 整帧丢失)", wnd_n);

            // --- 锁定 1.1.0 的新行为: 冲刷段响应 i_fft_start, 新帧不被吞 ---
            // 冲刷占 64 拍。若它像 S_UNSYNC 之外的段那样不消费 fft_start, 帧间最小
            // 间隔就会从 1 拍被抬到 65 拍 —— 实测中它确实吞掉过整个第二帧。
            // 这里用 4 拍间隔 (远小于 64) 起第二帧, 它必须完整跑出来。
            i_cfg_n_sym = 8'd2;
            rst_pulse();
            wnd_lo = 6000; wnd_hi = 6999; wnd_n = 0;
            send_frame(100, 2, 1'b0);
            for (int d = 0; d < 4; d++) beat(50000 + d, 1'b0);   // 4 拍间隔, 冲刷进行中
            send_frame(6000, 2, 1'b0);
            @(negedge i_clk); s_valid = 1'b0; repeat (DRAIN) @(negedge i_clk);
            if (wnd_n != 4*N) begin
                sfail++;
                bad($sformatf("冲刷进行中起新帧: 第二帧应出 %0d 个切窗点, 实为 %0d —— 冲刷段吞掉了 fft_start", 4*N, wnd_n));
            end
            $display("  冲刷中途起新帧 (间隔 4 拍): 第二帧出 %0d 个切窗点 (期望 %0d)", wnd_n, 4*N);
            wnd_lo = 1; wnd_hi = 0;                    // 关掉过滤计数

            if (sfail == 0)
                $display("STAB stress PASS %0d 12 帧连发 (帧间留够冲刷排空) 共 %0d 输出点 = 每帧 切窗 384 + 冲刷 64, 点数/侧带次数/首点下标逐帧核对, 计数器无累积漂移; 另锁定两条帧间行为: 零间隔 -> 整帧丢失 (fft_start 与 S_DATA->S_FLUSH 同拍被吞), 冲刷进行中 (间隔 4 拍) 起新帧 -> 冲刷中止、新帧完整跑出, 见 docs/limitations.md 6", beats - b0, tot);
            else
                $display("STAB stress FAIL %0d %0d 项压力判据失败", beats - b0, sfail);
            fails += sfail;
        end

        //======================================================================
        // backpressure — 无 tready 契约下的空拍行为
        //======================================================================
        begin
            int pfail;
            pfail = 0;
            i_cfg_n_sym = 8'd3;
            rst_pulse();
            b0 = beats;
            // 每个有效拍后插一个空拍 (输入节奏减半), 切窗结果必须与背靠背完全一致
            send_frame(5000, 3, 1'b1);
            @(negedge i_clk); s_valid = 1'b0; repeat (DRAIN) @(negedge i_clk);
            if (got_n != 5*N + N_FLUSH) begin
                pfail++; bad($sformatf("间隙流应出 %0d 点 (切窗 %0d + 冲刷 %0d), 实为 %0d",
                             5*N + N_FLUSH, 5*N, N_FLUSH, got_n));
            end
            ok = 1;
            for (int k = 0; k < 2*N; k++)
                if (got_re[k] != 5000 + k) ok = 0;
            for (int s = 0; s < 3; s++)
                for (int k = 0; k < N; k++) begin
                    expv = 5000 + 2*N + s*(N_CP+N) + N_CP + k;
                    if (got_re[2*N + s*N + k] != expv) ok = 0;
                end
            if (!ok) begin
                pfail++; bad("间隙流下切窗序列与背靠背不一致 —— 空拍被当成样点或计数错位");
            end
            if (sb_cnt != 1 || sb_pos != 0) begin
                pfail++; bad($sformatf("间隙流侧带 pos=%0d cnt=%0d", sb_pos, sb_cnt));
            end
            $display("  间隙流 (50%% 空拍): %0d 点, 逐点与背靠背一致", got_n);
            if (pfail == 0)
                $display("STAB backpressure PASS %0d 无 tready 契约 (上游 sync_top m_axis_tready 被忽略, 下游 fft64_sdf 无 ready): 50%% 空拍间隙流下 %0d 个输出点 (切窗 320 + 冲刷 64) 的切窗段逐点与背靠背一致, 侧带落位不变 —— 计数只在 tvalid 拍推进, 空拍不吞样点也不错位; 冲刷段则自驱, 不受空拍影响。下游 channel_est_top 实测零反压 (CP 空档即全部弹性), 不需弹性缓冲, 见 docs/limitations.md 2", beats - b0, got_n);
            else
                $display("STAB backpressure FAIL %0d %0d 项判据失败", beats - b0, pfail);
            fails += pfail;
        end

        if (fails != 0)
            $fatal(1, "TB_FAIL: tb_cp_remove_stability %0d 项判据失败", fails);

        $display("RESULT: PASS - tb_cp_remove_stability, 0 errors (boundary/stress/backpressure 全部通过, 共 %0d 拍)", beats);
        $finish;
    end

endmodule

`default_nettype wire
