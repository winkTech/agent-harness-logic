//==============================================================================
// tb_sb_align_stability — G-C-05 的三个具名子结果 (boundary/stress/backpressure);
// regression 由 run_sim.cjs 汇总既有判据 TB。
//
// 子结果与判据:
//   boundary     边界情形 —— 每拍都带 sb (气泡与样点交替的极端)、连续两个 sb 相邻、
//                单拍帧、以及深度边界 (恰好灌满 P_DEPTH 不得溢出, 再多一拍必须溢出)。
//   stress       长程: 64 个符号连发, 侧带落位与数据序不得漂移。
//   backpressure 本件是链路里**唯一**握手两侧不对称的地方 (上游无 ready、下游有),
//                故这一项对它最要紧: 分档测不同占空的反压, 在深度能吸收的范围内
//                必须逐点无损; 超出范围必须由 o_overflow 如实报出, 而不是静默丢。
//
// 输出格式 (供 run_sim.cjs 解析成 stability/<name>.json):
//   STAB <name> <PASS|FAIL> <beats> <reason>
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_sb_align_stability;

    localparam int DATA_W  = 16;
    localparam int P_DEPTH = 4;
    localparam int N       = 64;

    logic i_clk = 1'b0, i_rst = 1'b1;
    logic i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_frame_start, m_axis_tvalid, o_overflow;
    logic m_axis_tready = 1'b1;
    logic [DATA_W*2-1:0] m_axis_tdata;

    int fails = 0, beats = 0;

    always #5 i_clk = ~i_clk;

    sb_align #(.DATA_W(DATA_W), .P_DEPTH(P_DEPTH)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(i_valid), .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_frame_start(o_frame_start),
        .m_axis_tvalid(m_axis_tvalid), .m_axis_tready(m_axis_tready),
        .m_axis_tdata(m_axis_tdata), .o_overflow(o_overflow));

    // 采集
    int got_v [0:8191];
    bit got_fs[0:8191];
    int got_n = 0, fs_cnt = 0, fs_with_tvalid = 0;
    bit r_fs_prev = 1'b0;

    always @(posedge i_clk) begin
        if (!i_rst) begin
            if (o_frame_start && m_axis_tvalid) fs_with_tvalid <= fs_with_tvalid + 1;
            if (o_frame_start) fs_cnt <= fs_cnt + 1;
            if (m_axis_tvalid && m_axis_tready) begin
                if (got_n < 8192) begin
                    got_v[got_n]  <= int'($signed(m_axis_tdata[DATA_W-1:0]));
                    got_fs[got_n] <= r_fs_prev;
                end
                got_n <= got_n + 1;
            end
            r_fs_prev <= o_frame_start;
        end
    end

    task automatic bad(input string what);
        fails++; $display("  [FAIL] %s", what);
    endtask

    task automatic push(input int idx, input bit sb);
        @(negedge i_clk);
        i_valid = 1'b1; i_sb = sb;
        i_re = DATA_W'(idx); i_im = DATA_W'(-idx);
        beats++;
    endtask

    task automatic idle_beat();
        @(negedge i_clk);
        i_valid = 1'b0; i_sb = 1'b0;
        beats++;
    endtask

    task automatic rst_pulse();
        @(negedge i_clk); i_valid = 1'b0; i_sb = 1'b0; m_axis_tready = 1'b1;
        i_rst = 1'b1; repeat (4) @(negedge i_clk); i_rst = 1'b0;
        @(negedge i_clk);
        got_n = 0; fs_cnt = 0; fs_with_tvalid = 0;
    endtask

    int b0, ok;

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        //======================================================================
        // boundary
        //======================================================================
        begin
            int bfail; bfail = 0;

            // --- B1. 每拍都带 sb: 气泡与样点严格交替, 吞吐减半但不得丢 ---
            rst_pulse(); b0 = beats;
            for (int k = 0; k < 8; k++) begin push(100 + k, 1'b1); idle_beat(); end
            repeat (40) @(negedge i_clk);
            if (got_n != 8) begin
                bfail++; bad($sformatf("每拍带 sb: 应出 8 点, 实为 %0d", got_n));
            end
            if (fs_cnt != 8) begin
                bfail++; bad($sformatf("每拍带 sb: frame_start 应 8 次, 实为 %0d", fs_cnt));
            end
            ok = 1;
            for (int k = 0; k < got_n && k < 8; k++)
                if (got_v[k] != 100 + k || !got_fs[k]) ok = 0;
            if (!ok) begin bfail++; bad("每拍带 sb: 值或侧带落位错"); end
            $display("  B1 每拍带 sb: %0d 点, frame_start %0d 次, 气泡样点严格交替", got_n, fs_cnt);

            // --- B2. 相邻两个 sb (背靠背单拍帧) ---
            rst_pulse();
            push(200, 1'b1); push(201, 1'b1);
            for (int k = 0; k < 4; k++) push(202 + k, 1'b0);
            @(negedge i_clk); i_valid = 1'b0;
            repeat (40) @(negedge i_clk);
            if (got_n != 6) begin
                bfail++; bad($sformatf("相邻 sb: 应出 6 点, 实为 %0d", got_n));
            end
            if (got_n >= 2 && !(got_fs[0] && got_fs[1])) begin
                bfail++; bad("相邻 sb: 前两点都应各自被 frame_start 领先");
            end
            $display("  B2 相邻两个 sb: %0d 点, 前两点各自被领先", got_n);

            // --- B3. 吸收能力: **测出**溢出门限, 再断言它等于文档值 ---
            // 有效吸收 = P_DEPTH (FIFO) + 1 (输出寄存器) —— 后者是红线 2 要求的那一级,
            // 它也能压住一个样点。所以门限不是 P_DEPTH 而是 P_DEPTH+1。
            // 这里逐拍灌到溢出为止把门限测出来, 而不是断言一个猜的数; 将来谁改了
            // 结构 (例如去掉输出寄存或改深度), 这条会失败并报出新门限。
            begin
                // iverilog 不支持 break, 用标志位收尾
                int cap; bit done;
                cap = 0; done = 1'b0;
                rst_pulse();
                m_axis_tready = 1'b0;
                for (int k = 0; k < P_DEPTH + 6; k++) begin
                    if (!done) begin
                        push(300 + k, 1'b0);
                        @(negedge i_clk); i_valid = 1'b0;
                        repeat (2) @(negedge i_clk);
                        if (o_overflow === 1'b0) cap = k + 1;   // 到目前为止都没丢
                        else done = 1'b1;
                    end
                end
                m_axis_tready = 1'b1;
                $display("  B3 吸收能力实测: %0d 拍 (P_DEPTH=%0d 的 FIFO + 1 级输出寄存)", cap, P_DEPTH);
                if (cap != P_DEPTH + 1) begin
                    bfail++;
                    bad($sformatf("吸收能力实测 %0d, 文档值 P_DEPTH+1=%0d —— 结构变了就更新 docs/limitations.md 2",
                                  cap, P_DEPTH + 1));
                end
            end

            if (bfail == 0)
                $display("STAB boundary PASS %0d 边界情形: 每拍带 sb (气泡与样点严格交替, 吞吐减半但不丢)、相邻两个 sb (背靠背单拍帧, 各自被领先)、吸收能力实测 %0d 拍 = P_DEPTH(%0d) 的 FIFO + 1 级输出寄存 —— 该门限是**逐拍测出来的**而非断言猜值, 结构一变这条就会失败并报出新值", beats - b0, P_DEPTH + 1, P_DEPTH);
            else
                $display("STAB boundary FAIL %0d %0d 项边界判据失败", beats - b0, bfail);
            fails += bfail;
        end

        //======================================================================
        // stress — 64 符号长程
        //======================================================================
        begin
            int sfail, nsym; sfail = 0; nsym = 64;
            rst_pulse(); b0 = beats;
            for (int s = 0; s < nsym; s++) begin
                for (int k = 0; k < N; k++) push(s*N + k, (k == 0));
                for (int g = 0; g < 16; g++) idle_beat();     // 模拟 CP 空档
            end
            @(negedge i_clk); i_valid = 1'b0;
            repeat (60) @(negedge i_clk);

            if (got_n != nsym*N) begin
                sfail++; bad($sformatf("长程应出 %0d 点, 实为 %0d", nsym*N, got_n));
            end
            if (fs_cnt != nsym) begin
                sfail++; bad($sformatf("长程 frame_start 应 %0d 次, 实为 %0d", nsym, fs_cnt));
            end
            if (fs_with_tvalid != 0) begin
                sfail++; bad($sformatf("长程中报 frame_start 的拍不得送样点, 实为 %0d 次", fs_with_tvalid));
            end
            ok = 1;
            for (int k = 0; k < got_n && k < nsym*N; k++) begin
                if (got_v[k] != k) ok = 0;
                if (got_fs[k] != ((k % N) == 0)) ok = 0;
            end
            if (!ok) begin sfail++; bad("长程中数据序或侧带落位漂移"); end
            if (o_overflow !== 1'b0) begin sfail++; bad("长程中不应溢出"); end
            $display("  64 符号长程: %0d 点, frame_start %0d 次且均落在符号首点前一拍", got_n, fs_cnt);

            if (sfail == 0)
                $display("STAB stress PASS %0d 64 个符号连发 (每符号 64 拍 + 16 拍空档) 共 %0d 输出点: 数据逐点等于输入下标、frame_start 恰 %0d 次且每次都落在符号首点的前一拍、报的那拍从不送样点、全程无溢出 —— 指针与 announce 状态在长程下无累积漂移", beats - b0, got_n, fs_cnt);
            else
                $display("STAB stress FAIL %0d %0d 项压力判据失败", beats - b0, sfail);
            fails += sfail;
        end

        //======================================================================
        // backpressure — 本件最要紧的一项 (握手两侧不对称)
        //======================================================================
        begin
            int pfail, ref_n, stall_len;
            int ref_v [0:2047];
            pfail = 0;
            b0 = beats;

            // 参考跑: tready 恒高
            rst_pulse();
            for (int s = 0; s < 4; s++) begin
                for (int k = 0; k < N; k++) push(s*N + k, (k == 0));
                for (int g = 0; g < 16; g++) idle_beat();
            end
            @(negedge i_clk); i_valid = 1'b0;
            repeat (60) @(negedge i_clk);
            ref_n = got_n;
            for (int k = 0; k < ref_n && k < 2048; k++) ref_v[k] = got_v[k];

            // 分档: 每符号头 stall_len 拍拉低。<= P_DEPTH-1 必须无损。
            for (stall_len = 1; stall_len <= P_DEPTH - 1; stall_len++) begin
                rst_pulse();
                fork
                    begin
                        for (int s = 0; s < 4; s++) begin
                            for (int k = 0; k < N; k++) push(s*N + k, (k == 0));
                            for (int g = 0; g < 16; g++) idle_beat();
                        end
                        @(negedge i_clk); i_valid = 1'b0;
                    end
                    begin
                        for (int t = 0; t < 4*(N+16) + 80; t++) begin
                            @(negedge i_clk);
                            m_axis_tready = ((t % (N+16)) >= stall_len);
                        end
                    end
                join
                m_axis_tready = 1'b1;
                repeat (80) @(negedge i_clk);

                if (o_overflow !== 1'b0) begin
                    pfail++; bad($sformatf("反压 %0d 拍 (<= P_DEPTH-1) 不应溢出", stall_len));
                end
                if (got_n != ref_n) begin
                    pfail++; bad($sformatf("反压 %0d 拍: 应出 %0d 点, 实为 %0d", stall_len, ref_n, got_n));
                end else begin
                    ok = 1;
                    for (int k = 0; k < ref_n; k++) if (got_v[k] != ref_v[k]) ok = 0;
                    if (!ok) begin
                        pfail++; bad($sformatf("反压 %0d 拍: 序列与恒高不一致", stall_len));
                    end
                end
                if (fs_with_tvalid != 0) begin
                    pfail++; bad($sformatf("反压 %0d 拍: 报 frame_start 的拍送了样点", stall_len));
                end
                $display("  反压 %0d 拍/符号: %0d 点逐点与恒高一致, 未溢出", stall_len, got_n);
            end

            // 超出吸收能力: 必须由 o_overflow 如实报出 (而非静默丢)
            rst_pulse();
            m_axis_tready = 1'b0;
            for (int k = 0; k < N; k++) push(9000 + k, (k == 0));
            @(negedge i_clk); i_valid = 1'b0;
            m_axis_tready = 1'b1;
            repeat (80) @(negedge i_clk);
            if (o_overflow !== 1'b1) begin
                pfail++; bad("持续反压下丢了数据却没有报 o_overflow —— 静默丢数据是本件最不该有的行为");
            end
            $display("  持续反压 (整符号不收): o_overflow=%0b (必须为 1)", o_overflow);

            if (pfail == 0)
                $display("STAB backpressure PASS %0d 本件是链路里唯一握手两侧不对称处 (上游无 ready, 下游有): 每符号头 1/2/3 拍反压 (<= P_DEPTH-1) 时 %0d 个输出点逐点与恒高一致且不溢出; 超出吸收能力 (整符号不收) 时 o_overflow 如实置起 —— 丢数据必须可见, 不得静默", beats - b0, ref_n);
            else
                $display("STAB backpressure FAIL %0d %0d 项判据失败", beats - b0, pfail);
            fails += pfail;
        end

        if (fails != 0)
            $fatal(1, "TB_FAIL: tb_sb_align_stability %0d 项判据失败", fails);

        $display("RESULT: PASS - tb_sb_align_stability, 0 errors (boundary/stress/backpressure 全部通过, 共 %0d 拍)", beats);
        $finish;
    end

endmodule

`default_nettype wire
