//==============================================================================
// tb_fft64_sdf_core — fft64_sdf_core 定向自检 TB
//
// 判据分两类:
//   (A) **解析可知**, 不依赖任何 golden 向量 —— 本 TB 现阶段的全部内容:
//         冲激输入 -> 频谱平坦 (所有 bin 幅值相等)
//         直流输入 -> 只有 bin 0 非零
//         Nyquist 交替输入 -> 只有 bin 32 非零
//         侧带 i_sb 必须在 o_sb 上恰好晚 P_LAT=69 拍出现
//         复位后不得有残留 valid
//       这些是结构性质, 错一处就说明蝶形/计数器/旋转指数接错了。
//   (B) 位真对拍 (0 容差, 对 golden rtl_mirror_fft64) —— 待 golden 向量落库后
//       由 tb_fft64_cosim 承接, 不在本文件。
//
// 反假绿: 任一判据失败即 $fatal(1), 使失败运行以非零码退出 —— 只 $display
//         的话失败运行仍 exit 0, 上游会读成通过。
//
// 输出为**位反序**流: 自然 bin = bitrev(o_idx)。
// 尾部冲刷: 送完 64 拍后继续馈拍 (零) 排空在途样点。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_sdf_core;

    localparam int DATA_W = 16;
    localparam int P_W    = 21;
    localparam int P_LAT  = 69;          // 63 (FIFO 深度和) + 3 + 3 (两个复乘)
    localparam int ONE    = 16384;       // Q2.14 的 1.0
    localparam int TOL    = 4;           // 舍入容差 (旋转乘 +8192>>>14 引入)

    logic i_clk = 1'b0, i_rst = 1'b1, i_beat = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_valid, o_sb;
    logic [5:0] o_idx;
    logic signed [DATA_W-1:0] o_re, o_im;

    int errors = 0;
    int cap_cnt = 0;
    logic signed [DATA_W-1:0] cap_re [0:63];
    logic signed [DATA_W-1:0] cap_im [0:63];
    int sb_out_beat = -1, sb_in_beat = -1, beat_no = 0, dat_out_beat = -1;
    int lat_data = -1, lat_sb = -1;   // 预热轮实测的延迟 (仅作信息打印)
    logic [5:0] sb_idx = '0;          // o_sb 那一拍的 o_idx —— 侧带对齐的判据
    logic       sb_seen = 1'b0;

    always #5 i_clk = ~i_clk;

    fft64_sdf_core #(.DATA_W(DATA_W), .P_W(P_W), .P_DIR(1'b0)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(o_valid), .o_idx(o_idx), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    function automatic logic [5:0] bitrev6(input logic [5:0] n);
        bitrev6 = {n[0], n[1], n[2], n[3], n[4], n[5]};
    endfunction

    task automatic check(input string what, input bit cond);
        if (!cond) begin
            $display("  [FAIL] %s", what);
            errors = errors + 1;
        end
    endtask

    // 输出捕获: **以侧带为symbol起点**对齐, 而不是从 feed 起数拍。
    // 上一符号的冲刷输出还在陆续出来, 从 feed 起数会捕到它的尾巴 (实测表现为
    // 直流 bin0 只有 12288 而非 16384 —— 窗口里混了两个符号)。
    // 用 o_sb 对齐同时也把侧带的用途本身验了: 它就是用来标记"这一拍是本符号首点"。
    // 全部用非阻塞赋值, 且 cap_cnt 只由本块驱动 —— feed() 不得再碰它。
    // 之前 capturing 用非阻塞、cap_cnt 由 task 阻塞清零, 两者竞争恰好吞掉每个
    // 符号的首个输出 (表现为 bin0 恒 0 而其余 63 个 bin 全对)。
    always @(posedge i_clk) begin
        if (!i_rst) begin
            if (o_valid && o_sb) begin                    // 侧带标记本符号首点
                cap_re[bitrev6(o_idx)] <= o_re;
                cap_im[bitrev6(o_idx)] <= o_im;
                cap_cnt <= 1;
            end else if (o_valid && cap_cnt > 0 && cap_cnt < 64) begin
                cap_re[bitrev6(o_idx)] <= o_re;
                cap_im[bitrev6(o_idx)] <= o_im;
                cap_cnt <= cap_cnt + 1;
            end
            beat_no <= beat_no + 1;
            if (o_sb && sb_out_beat < 0)      sb_out_beat  <= beat_no;
            if (o_valid && dat_out_beat < 0)  dat_out_beat <= beat_no;
            // 侧带对齐取证: 记下 o_sb 那一拍的 o_idx (契约要求为 0)
            if (o_sb && o_valid) begin
                sb_idx  <= o_idx;
                sb_seen <= 1'b1;
            end
        end
    end

    // 等本符号 64 点收齐
    task automatic wait_symbol();
        int guard;
        guard = 0;
        while (cap_cnt != 64 && guard < 4000) begin
            @(posedge i_clk);
            guard++;
        end
        check("符号 64 点应收齐", cap_cnt == 64);
    endtask

    // 送一符号 (64 拍) 后继续馈**有效**拍冲刷。
    // flush 必须是 64 的整数倍: SDF 的块边界由内部计数器按有效拍划分, 64+flush
    // 不是 64 的倍数时下一个符号会从块内偏移处开始。实测偏移 8 (64+200 mod 64)
    // 表现为冲激各 bin 幅度正确但相位按 -45°/bin 线性旋转, 直流 bin0 只剩 1/4。
    // 关键: 各级 FIFO 只在 `i_beat && w_v[SI]` 时移位, 所以拉低 i_valid 不排空流水,
    //       只是把在途样点冻在原地。冲刷必须送 valid 的零样点。
    task automatic feed(input int mode, input int amp, input int flush);
        // 注意: 不清 cap_cnt —— 它只由捕获块驱动, 由侧带自动重置为 1。
        beat_no = 0; sb_in_beat = -1; sb_out_beat = -1; dat_out_beat = -1;
        for (int n = 0; n < 64; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1;
            i_sb    = (n == 0);                       // 帧首打一拍侧带
            if (n == 0) sb_in_beat = beat_no;
            case (mode)
                0: begin i_re = (n == 0) ? DATA_W'(amp) : '0; i_im = '0; end        // 冲激
                1: begin i_re = DATA_W'(amp);                 i_im = '0; end        // 直流
                2: begin i_re = (n[0] ? -DATA_W'(amp) : DATA_W'(amp)); i_im = '0; end // Nyquist
                default: begin i_re = '0; i_im = '0; end
            endcase
        end
        // 冲刷: 保持 valid, 送零样点把在途样点推出去
        for (int n = 0; n < flush; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1; i_sb = 1'b0; i_re = '0; i_im = '0;
        end
        @(negedge i_clk);
        i_valid = 1'b0;
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // ---- 0. 预热: 各级 FIFO 按设计不复位, 首个符号会带出未初始化的 X。
        //      先灌一个零符号把 X 冲出去, 判据从第二个符号起才有意义。----
        feed(3, 0, 192);
        lat_data = dat_out_beat;
        lat_sb   = sb_out_beat - sb_in_beat;
        $display("  [信息] 数据首拍延迟 %0d, 侧带延迟 %0d (端到端, 含输入/输出寄存)",
                 lat_data, lat_sb);

        // ---- 1. 冲激 -> 频谱平坦 ----
        // x[0]=A, 其余 0 => X[k] = A/8 恒定 (净 /8 标定)
        feed(0, ONE, 192);
        wait_symbol();
        for (int k = 0; k < 64; k++) begin
            check($sformatf("冲激 bin%0d 实部应为 %0d, 实为 %0d", k, ONE/8, cap_re[k]),
                  (cap_re[k] > ONE/8 - TOL) && (cap_re[k] < ONE/8 + TOL));
            check($sformatf("冲激 bin%0d 虚部应近 0, 实为 %0d", k, cap_im[k]),
                  (cap_im[k] > -TOL) && (cap_im[k] < TOL));
        end

        // ---- 2. 侧带对齐 ----
        //   判据直接断言**契约本身**: o_sb 为高的那一拍, o_idx 必须为 0, 即侧带与
        //   它所标记符号的首个输出同拍。这样下游 channel_est_top 收到 frame_start
        //   时, 同拍的样点就是该符号的第一点。
        //   不用"侧带延迟 == 数据延迟"作判据: 那要靠拍号计数, 记录时机差半拍就会
        //   把整整一拍的偏移掩盖掉 —— 实测吃过这个亏 (显示 78==78 而实际差 1 拍)。
        check($sformatf("侧带须与符号首个输出同拍: o_sb 时 o_idx=%0d (应为 0)", sb_idx),
              sb_seen && (sb_idx == 0));

        // ---- 3. 直流 -> 只有 bin 0 ----
        // x[n]=A => X[0] = 64A/8 = 8A; 取 A=2048 使 8A=16384 不饱和
        feed(1, 2048, 192);
        check($sformatf("直流 bin0 应为 16384, 实为 %0d", cap_re[0]),
              (cap_re[0] > 16384 - TOL) && (cap_re[0] < 16384 + TOL));
        for (int k = 1; k < 64; k++)
            check($sformatf("直流 bin%0d 应近 0, 实为 %0d", k, cap_re[k]),
                  (cap_re[k] > -TOL) && (cap_re[k] < TOL));

        // ---- 4. Nyquist 交替 -> 只有 bin 32 ----
        feed(2, 2048, 192);
        check($sformatf("Nyquist bin32 应为 16384, 实为 %0d", cap_re[32]),
              (cap_re[32] > 16384 - TOL) && (cap_re[32] < 16384 + TOL));
        for (int k = 0; k < 64; k++) if (k != 32)
            check($sformatf("Nyquist bin%0d 应近 0, 实为 %0d", k, cap_re[k]),
                  (cap_re[k] > -TOL) && (cap_re[k] < TOL));

        // ---- 5. 复位后不得有残留 valid ----
        i_rst = 1'b1;
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        repeat (8) @(negedge i_clk);
        check("复位后 o_valid 应为 0", o_valid == 1'b0);

        if (errors == 0) begin
            $display("RESULT: PASS - tb_fft64_sdf_core, 0 errors (全部解析判据通过)");
            $finish;
        end else begin
            // 反假绿: 必须以非零码退出, 否则失败运行会被上游读成通过
            $fatal(1, "TB_FAIL: tb_fft64_sdf_core %0d 项判据失败", errors);
        end
    end

endmodule

`default_nettype wire
