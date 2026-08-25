//==============================================================================
// tb_fft64_tail — 锁定"尾部不冲刷就丢符号"这个行为, 以及**要补多少冲刷才够**
//
// 动因 (2026-08-04, M1 链路实测): 在 cp_remove -> fft64_sdf -> channel_est_top
// 的真实链路上, 帧结束后 cp_remove 转 UNSYNC 静默, fft64 再也收不到有效拍 ——
// 流水里最后的样点**永远出不来**, 每帧稳定丢符号。docs/limitations.md 5 早写了
// "拉低 i_valid 不排空流水", 但整条链路里没有任何人负责补这个冲刷。
//
// 本 TB 把这件事变成可执行的断言, 分两段:
//   T1  灌 N 个符号后直接撤 i_valid, 长时间等待 —— 出来的符号数必须**少于**灌进
//       去的; 少多少记为 STUCK_SYMS。若将来有人改了流水让它自排空, 这里会失败,
//       提示同步更新 limitations 与集成契约。
//   T2  同样灌 N 个符号, 再补 STUCK_SYMS 个零符号冲刷 —— 必须**一个不少**全部出来。
//       这就把"补多少才够"钉成了契约, 而不是留给集成方猜。
//
// 判据全部解析可知, 不依赖向量: 只数符号数与 o_idx 序, 不比数值。
// 反假绿: 任一断言失败即 $fatal(1)。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_tail;

    localparam int DATA_W = 16;
    localparam int NSYM   = 6;      // 正式符号数 (不含预热)

    logic i_clk = 1'b0, i_rst = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_valid, o_sb;
    logic [5:0] o_idx;
    logic signed [DATA_W-1:0] o_re, o_im;

    int outs = 0;
    int errors = 0;

    always #5 i_clk = ~i_clk;

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b1)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(1'b1), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(o_valid), .o_idx(o_idx), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    always @(posedge i_clk) if (!i_rst && o_valid) outs <= outs + 1;

    task automatic push(input int re, input int im, input bit sb);
        @(negedge i_clk);
        i_valid = 1'b1; i_sb = sb;
        i_re = DATA_W'(re); i_im = DATA_W'(im);
    endtask

    // 预热符号: FIFO 按设计不复位, 首符号必带未初始化值 (limitations 6)
    task automatic prime();
        for (int k = 0; k < 64; k++) push(0, 0, (k == 0));
    endtask

    task automatic body(input int n);
        for (int s = 0; s < n; s++)
            for (int k = 0; k < 64; k++)
                push(((s*37 + k*11) % 3000) - 1500,
                     ((s*53 + k*7)  % 3000) - 1500, (k == 0));
    endtask

    task automatic rst_pulse();
        @(negedge i_clk); i_valid = 1'b0; i_sb = 1'b0;
        i_rst = 1'b1; repeat (4) @(negedge i_clk); i_rst = 1'b0;
        @(negedge i_clk);
        outs = 0;
    endtask

    task automatic bad(input string what);
        errors++;
        $display("  [FAIL] %s", what);
    endtask

    int in_syms, out_syms_t1, stuck_syms, out_syms_t2;

    initial begin
        in_syms = 1 + NSYM;                 // 预热 + 正式

        //----------------------------------------------------------------------
        // T1 — 撤 i_valid 不冲刷: 尾巴必须卡住
        //----------------------------------------------------------------------
        rst_pulse();
        prime();
        body(NSYM);
        @(negedge i_clk); i_valid = 1'b0;   // 直接撤, 不补任何冲刷
        repeat (1000) @(negedge i_clk);     // 远超总延迟 75 拍

        if (outs % 64 != 0)
            bad($sformatf("T1 输出 %0d 点, 不是 64 的整数倍 —— 符号被截断了", outs));
        out_syms_t1 = outs / 64;
        stuck_syms  = in_syms - out_syms_t1;

        $display("TAIL_IN_SYMS %0d", in_syms);
        $display("TAIL_OUT_SYMS_NOFLUSH %0d", out_syms_t1);
        $display("TAIL_STUCK_SYMS %0d", stuck_syms);

        if (stuck_syms <= 0)
            bad("T1 撤 valid 后符号全出来了 —— 与 limitations 5 的'拉低 i_valid 不排空流水'矛盾, 请同步更新该节与集成契约");

        //----------------------------------------------------------------------
        // T2 — 补 STUCK_SYMS 个零符号冲刷: 必须一个不少全出来
        //----------------------------------------------------------------------
        rst_pulse();
        prime();
        body(NSYM);
        for (int k = 0; k < stuck_syms * 64; k++) push(0, 0, 1'b0);
        @(negedge i_clk); i_valid = 1'b0;
        repeat (1000) @(negedge i_clk);

        if (outs % 64 != 0)
            bad($sformatf("T2 输出 %0d 点, 不是 64 的整数倍", outs));
        out_syms_t2 = outs / 64;
        $display("TAIL_OUT_SYMS_FLUSHED %0d", out_syms_t2);

        // 补了 stuck_syms 个冲刷符号后, 原来的 in_syms 个必须全部出来。
        // 冲刷符号本身也会被变换后吐出来, 故总数应 >= in_syms。
        if (out_syms_t2 < in_syms)
            bad($sformatf("T2 补 %0d 个符号冲刷后仍只出 %0d/%0d —— 冲刷量不足以排空",
                stuck_syms, out_syms_t2, in_syms));

        if (errors != 0)
            $fatal(1, "TB_FAIL: tb_fft64_tail %0d 项判据失败", errors);

        $display("RESULT: PASS - tb_fft64_tail, 0 errors (撤 valid 卡住 %0d 个符号; 补等量冲刷后 %0d 个全部排空)",
                 stuck_syms, in_syms);
        $finish;
    end

endmodule

`default_nettype wire
