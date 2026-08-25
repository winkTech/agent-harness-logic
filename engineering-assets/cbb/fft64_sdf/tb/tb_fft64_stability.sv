//==============================================================================
// tb_fft64_stability — G-C-05 的三个子结果 (boundary/stress/backpressure);
// regression 由 run_sim.cjs 汇总既有判据 TB。
//
// 子结果与判据:
//   boundary     满幅 Q2.14 病态输入 —— 满幅直流的 bin0 理论值 64x/8 = 8x 远超
//                s16, 输出级**必须饱和到 +32767 而不是回绕成负数**。回绕是 s21
//                不够时的表现形式, 这条直接把它钉死。另测满幅 Nyquist 交替序列。
//   stress       64 个符号连续跑 (4096 拍): 每符号 o_idx 必须是完整的 0..63,
//                o_sb 每符号恰好一次且落在 idx==0 —— 计数器/乒乓若有累积漂移,
//                长程下必然暴露。
//   backpressure 本模块**无 ready**, 其等价性质是 i_beat (时钟使能) 可以任意
//                拉低: 整条流水冻结, 不丢不乱。判据是"i_beat 随机拉低跑出的
//                输出序列, 与 i_beat 恒高逐点完全相同"。这不是"支持反压",
//                而是"停顿由 CE 承担, 且停顿不改变结果"。
//
// 输出格式 (供 run_sim.cjs 解析成 stability/<name>.json):
//   STAB <name> <PASS|FAIL> <beats> <reason>
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_stability;

    localparam int DATA_W = 16;
    localparam int MAXO   = 8192;

    logic i_clk = 1'b0, i_rst = 1'b1, i_beat = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_valid, o_sb;
    logic [5:0] o_idx;
    logic signed [DATA_W-1:0] o_re, o_im;

    int  cap_re [0:MAXO-1];
    int  cap_im [0:MAXO-1];
    int  cap_idx[0:MAXO-1];
    bit  cap_sb [0:MAXO-1];
    int  cap_n = 0;
    bit  capture = 1'b0;

    int beats = 0, fails = 0;

    always #5 i_clk = ~i_clk;

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b1)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(o_valid), .o_idx(o_idx), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    // 捕获只在 i_beat 为高时进行 —— i_beat 低时整个 DUT 冻结, 输出线上的值是
    // 上一拍的残留, 不是新样点。把残留也捕进来会让两次运行"看起来"不同。
    always @(posedge i_clk) begin
        if (!i_rst && i_beat && o_valid && capture && cap_n < MAXO) begin
            cap_re[cap_n]  <= int'(o_re);
            cap_im[cap_n]  <= int'(o_im);
            cap_idx[cap_n] <= int'(o_idx);
            cap_sb[cap_n]  <= o_sb;
            cap_n          <= cap_n + 1;
        end
    end

    task automatic bad(input string what);
        fails++;
        $display("  [FAIL] %s", what);
    endtask

    task automatic rst_pulse();
        @(negedge i_clk);
        i_valid = 1'b0; i_sb = 1'b0; i_beat = 1'b1;
        i_rst = 1'b1; repeat (4) @(negedge i_clk); i_rst = 1'b0;
        @(negedge i_clk);
        cap_n = 0;
    endtask

    // 送一拍 (i_beat 恒高)
    task automatic push(input int re, input int im, input bit sb);
        @(negedge i_clk);
        i_beat = 1'b1; i_valid = 1'b1; i_sb = sb;
        i_re = DATA_W'(re); i_im = DATA_W'(im);
        beats++;
    endtask

    // 送一拍, 但前面先插 stall 个 i_beat=0 的冻结拍
    task automatic push_stall(input int re, input int im, input bit sb, input int stall);
        for (int s = 0; s < stall; s++) begin
            @(negedge i_clk);
            i_beat = 1'b0;
            // 冻结期间把输入线换成毒值: 若 DUT 在 i_beat=0 时误采, 结果立刻不同
            i_re = DATA_W'(-32768); i_im = DATA_W'(32767); i_valid = 1'b1; i_sb = 1'b1;
            beats++;
        end
        push(re, im, sb);
    endtask

    // 预热一个零符号 (FIFO 不复位, 首符号必带未初始化值)
    task automatic prime();
        for (int k = 0; k < 64; k++) push(0, 0, (k == 0));
    endtask

    task automatic flush(input int nsym);
        for (int k = 0; k < nsym * 64; k++) push(0, 0, 1'b0);
    endtask

    // 预热符号的输出也会被捕获 (FIFO 不复位, 首符号必带未初始化值 —— limitations 6),
    // 故真正要看的符号从第 OFF 个输出点开始。tb_fft64_cosim 用的是同一个约定。
    localparam int OFF = 64;

    int b0, base;

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        //======================================================================
        // boundary — 满幅病态输入下必须饱和而非回绕
        //======================================================================
        begin
            int bfail, bin0_re, maxother, negcnt;
            bfail = 0;
            rst_pulse();
            b0 = beats;
            prime();
            capture = 1'b1; cap_n = 0;

            // --- B1. 满幅直流: bin0 理论 64*32767/8 = 262136, 远超 s16 ---
            for (int k = 0; k < 64; k++) push(32767, 0, (k == 0));
            flush(4);
            @(negedge i_clk); i_valid = 1'b0;
            repeat (200) @(negedge i_clk);
            capture = 1'b0;

            if (cap_n < OFF + 64) begin
                bfail++; bad($sformatf("满幅直流只出 %0d 点, 需 >= %0d (含预热符号)", cap_n, OFF+64));
            end else begin
                bin0_re = cap_re[OFF];
                maxother = 0;
                negcnt = 0;
                for (int k = 1; k < 64; k++) begin
                    if (cap_re[OFF+k] > maxother)  maxother = cap_re[OFF+k];
                    if (-cap_re[OFF+k] > maxother) maxother = -cap_re[OFF+k];
                end
                // 饱和判据: bin0 必须是**正的** +32767。回绕会把它变成负数或小值。
                if (bin0_re != 32767) begin
                    bfail++;
                    bad($sformatf("满幅直流 bin0 = %0d, 期望饱和到 +32767 (若为负数即 s21 回绕)", bin0_re));
                end
                if (maxother > 8) begin
                    bfail++;
                    bad($sformatf("满幅直流的非零 bin 最大 %0d, 应接近 0", maxother));
                end
                $display("  B1 满幅直流: bin0=%0d (饱和), 其余 bin 最大 %0d", bin0_re, maxother);
            end

            // --- B2. 满幅 Nyquist 交替 (+FS, -FS, ...): 能量应全在 bin32 ---
            rst_pulse();
            prime();
            capture = 1'b1; cap_n = 0;
            for (int k = 0; k < 64; k++) push((k % 2 == 0) ? 32767 : -32768, 0, (k == 0));
            flush(4);
            @(negedge i_clk); i_valid = 1'b0;
            repeat (200) @(negedge i_clk);
            capture = 1'b0;

            if (cap_n < OFF + 64) begin
                bfail++; bad($sformatf("满幅 Nyquist 只出 %0d 点, 需 >= %0d (含预热符号)", cap_n, OFF+64));
            end else begin
                maxother = 0;
                for (int k = 0; k < 64; k++)
                    if (k != 32) begin
                        if (cap_re[OFF+k] > maxother)  maxother = cap_re[OFF+k];
                        if (-cap_re[OFF+k] > maxother) maxother = -cap_re[OFF+k];
                    end
                // bin32 应饱和 (交替序列的能量全在 Nyquist)
                if (cap_re[OFF+32] > -32000 && cap_re[OFF+32] < 32000) begin
                    bfail++;
                    bad($sformatf("满幅 Nyquist bin32 = %0d, 应饱和到 ±32767 附近", cap_re[OFF+32]));
                end
                if (maxother > 8) begin
                    bfail++;
                    bad($sformatf("满幅 Nyquist 的非 bin32 最大 %0d, 应接近 0", maxother));
                end
                $display("  B2 满幅 Nyquist: bin32=%0d (饱和), 其余 bin 最大 %0d", cap_re[OFF+32], maxother);
            end

            if (bfail == 0)
                $display("STAB boundary PASS %0d 满幅 Q2.14 病态输入: 直流下 bin0 饱和到 +32767 (非回绕成负数), Nyquist 交替下能量全在 bin32 且饱和, 两者非目标 bin 均 <=8 LSB —— s21 内部位宽在满幅工况下不回绕, 溢出由输出级饱和吸收", beats - b0);
            else
                $display("STAB boundary FAIL %0d %0d 项边界判据失败", beats - b0, bfail);
            fails += bfail;
        end

        //======================================================================
        // stress — 64 符号长程, 检查输出序与侧带不漂移
        //======================================================================
        begin
            int sfail, nsym, sbcnt;
            sfail = 0; nsym = 64;
            rst_pulse();
            b0 = beats;
            prime();
            capture = 1'b1; cap_n = 0;
            for (int s = 0; s < nsym; s++)
                for (int k = 0; k < 64; k++)
                    push(((s * 37 + k * 11) % 4000) - 2000,
                         ((s * 53 + k * 7)  % 4000) - 2000, (k == 0));
            flush(4);
            @(negedge i_clk); i_valid = 1'b0;
            repeat (300) @(negedge i_clk);
            capture = 1'b0;

            if (cap_n < OFF + nsym * 64) begin
                sfail++; bad($sformatf("长程只出 %0d 点, 期望 >= %0d (含预热符号)", cap_n, OFF + nsym*64));
            end else begin
                // 每符号 o_idx 必须是完整的 0..63, o_sb 恰好一次且在 idx==0
                for (int s = 0; s < nsym; s++) begin
                    sbcnt = 0;
                    for (int k = 0; k < 64; k++) begin
                        if (cap_idx[OFF + s*64 + k] != k) begin
                            sfail++;
                            bad($sformatf("符号 %0d 第 %0d 点 o_idx=%0d 期望 %0d", s, k, cap_idx[OFF+s*64+k], k));
                        end
                        if (cap_sb[OFF + s*64 + k]) begin
                            sbcnt++;
                            if (k != 0) begin
                                sfail++;
                                bad($sformatf("符号 %0d 的 o_sb 落在 idx=%0d, 应为 0", s, k));
                            end
                        end
                    end
                    if (sbcnt != 1) begin
                        sfail++;
                        bad($sformatf("符号 %0d 的 o_sb 出现 %0d 次, 应为 1", s, sbcnt));
                    end
                end
                $display("  64 符号长程: %0d 点, 每符号 o_idx 0..63 完整, o_sb 各 1 次且落在 idx=0", cap_n);
            end

            if (sfail == 0)
                $display("STAB stress PASS %0d 64 个符号连续跑 (%0d 输出点): 每符号 o_idx 完整覆盖 0..63 且顺序正确, o_sb 每符号恰 1 次并落在 idx=0 —— SDF 各级计数器与重排乒乓在长程下无累积漂移", beats - b0, cap_n);
            else
                $display("STAB stress FAIL %0d %0d 项压力判据失败", beats - b0, sfail);
            fails += sfail;
        end

        //======================================================================
        // backpressure — i_beat 任意拉低, 结果必须逐点不变
        //======================================================================
        begin
            int pfail, n_ref, stall_pat;
            int ref_re [0:2047];
            int ref_im [0:2047];
            int ref_idx[0:2047];
            pfail = 0;
            b0 = beats;

            // --- 参考跑: i_beat 恒高 ---
            rst_pulse();
            prime();
            capture = 1'b1; cap_n = 0;
            for (int s = 0; s < 8; s++)
                for (int k = 0; k < 64; k++)
                    push(((s * 91 + k * 17) % 3000) - 1500,
                         ((s * 29 + k * 23) % 3000) - 1500, (k == 0));
            flush(4);
            @(negedge i_clk); i_valid = 1'b0;
            repeat (300) @(negedge i_clk);
            capture = 1'b0;
            n_ref = cap_n;
            for (int k = 0; k < n_ref && k < 2048; k++) begin
                ref_re[k]  = cap_re[k];
                ref_im[k]  = cap_im[k];
                ref_idx[k] = cap_idx[k];
            end
            $display("  参考跑 (i_beat 恒高): %0d 点", n_ref);

            // --- 冻结跑: i_beat 按固定花样拉低 0..3 拍 ---
            rst_pulse();
            for (int k = 0; k < 64; k++) push_stall(0, 0, (k == 0), k % 4);
            capture = 1'b1; cap_n = 0;
            for (int s = 0; s < 8; s++)
                for (int k = 0; k < 64; k++) begin
                    stall_pat = (s + k) % 4;          // 0..3 拍冻结, 覆盖连续多拍
                    push_stall(((s * 91 + k * 17) % 3000) - 1500,
                               ((s * 29 + k * 23) % 3000) - 1500, (k == 0), stall_pat);
                end
            for (int k = 0; k < 4 * 64; k++) push_stall(0, 0, 1'b0, k % 3);
            @(negedge i_clk); i_valid = 1'b0; i_beat = 1'b1;
            repeat (300) @(negedge i_clk);
            capture = 1'b0;

            if (cap_n != n_ref) begin
                pfail++;
                bad($sformatf("冻结跑出 %0d 点, 参考跑 %0d 点 —— 点数就不一致", cap_n, n_ref));
            end else begin
                for (int k = 0; k < n_ref && k < 2048; k++)
                    if (cap_re[k] != ref_re[k] || cap_im[k] != ref_im[k] || cap_idx[k] != ref_idx[k]) begin
                        if (pfail < 5)
                            bad($sformatf("第 %0d 点 冻结跑 (%0d,%0d,idx%0d) vs 参考 (%0d,%0d,idx%0d)",
                                k, cap_re[k], cap_im[k], cap_idx[k], ref_re[k], ref_im[k], ref_idx[k]));
                        pfail++;
                    end
                if (pfail == 0)
                    $display("  冻结跑 (i_beat 拉低 0~3 拍): %0d 点, 逐点与参考跑完全相同", cap_n);
            end

            if (pfail == 0)
                $display("STAB backpressure PASS %0d 无 ready 契约, 停顿由 i_beat (CE) 承担: i_beat 按 0~3 拍花样拉低时 %0d 个输出点的 (re, im, o_idx) 逐点与 i_beat 恒高的参考跑完全相同; 冻结期间输入线换成满幅毒值也未被采样 —— 停顿不改变结果, 也不吞样点。弹性缓冲仍是集成硬依赖 (下游 channel_est_top 会拉低 tready 而本模块不能被停)", beats - b0, n_ref);
            else
                $display("STAB backpressure FAIL %0d %0d 点与参考跑不一致", beats - b0, pfail);
            fails += pfail;
        end

        if (fails != 0)
            $fatal(1, "TB_FAIL: tb_fft64_stability %0d 项判据失败", fails);

        $display("RESULT: PASS - tb_fft64_stability, 0 errors (boundary/stress/backpressure 全部通过, 共 %0d 拍)", beats);
        $finish;
    end

endmodule

`default_nettype wire
