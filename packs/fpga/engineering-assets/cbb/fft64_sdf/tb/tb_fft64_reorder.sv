//==============================================================================
// tb_fft64_reorder — fft64_reorder 定向自检 TB
//
// 判据 (全部解析可知, 不依赖 golden):
//   1. 位反序流进 -> 自然序流出: 令输入第 n 拍的样点值 = bitrev(n), 则输出第 m
//      拍的值必须恰为 m。错一位就说明写地址或读序接反了。
//   2. 侧带: 输入侧带标记本符号首拍, 输出侧带必须标记**自然序**符号的首拍。
//   3. 连续两符号背靠背不得串扰 (乒乓切换正确)。
//   4. 复位后无残留 valid。
//
// 反假绿: 任一判据失败即 $fatal(1), 使失败运行以非零码退出。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_reorder;

    localparam int DATA_W = 16;

    logic i_clk = 1'b0, i_rst = 1'b1, i_beat = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic [5:0] i_idx = '0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_valid, o_sb;
    logic signed [DATA_W-1:0] o_re, o_im;

    int errors = 0;
    int out_cnt = 0;
    int sb_out_pos = -1;
    logic signed [DATA_W-1:0] got_re [0:127];
    int got_n = 0;

    always #5 i_clk = ~i_clk;

    logic [5:0] o_idx;
    fft64_reorder #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat),
        .i_valid(i_valid), .i_idx(i_idx), .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
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

    // 收集输出; 记录侧带落在第几个输出上
    always @(posedge i_clk) begin
        if (!i_rst && o_valid) begin
            if (got_n < 128) got_re[got_n] <= o_re;
            if (o_sb && sb_out_pos < 0) sb_out_pos <= got_n;
            got_n <= got_n + 1;
        end
    end

    // 送一个符号: 第 n 拍值 = bitrev(n) + base, 侧带打在 n=0
    task automatic send_symbol(input int base);
        for (int n = 0; n < 64; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1;
            i_idx   = 6'(n);
            i_sb    = (n == 0);
            i_re    = DATA_W'(bitrev6(6'(n)) + base);
            i_im    = DATA_W'(-(bitrev6(6'(n)) + base));
        end
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // 背靠背两符号: base 分别为 0 和 100, 用于查乒乓串扰
        send_symbol(0);
        send_symbol(100);
        @(negedge i_clk);
        i_valid = 1'b0; i_sb = 1'b0;
        repeat (200) @(negedge i_clk);

        // ---- 1. 自然序: 第 m 个输出应为 m (第一符号) / m+100 (第二符号) ----
        check($sformatf("应收满 128 点, 实收 %0d", got_n), got_n >= 128);
        for (int m = 0; m < 64; m++)
            check($sformatf("符号1 第 %0d 点应为 %0d, 实为 %0d", m, m, got_re[m]),
                  got_re[m] == DATA_W'(m));
        // ---- 3. 乒乓不串扰: 第二符号必须整体 +100 ----
        for (int m = 0; m < 64; m++)
            check($sformatf("符号2 第 %0d 点应为 %0d, 实为 %0d", m, m+100, got_re[64+m]),
                  got_re[64+m] == DATA_W'(m + 100));

        // ---- 2. 侧带须落在自然序符号的首拍 ----
        check($sformatf("输出侧带应落在第 0 个输出上, 实为第 %0d 个", sb_out_pos),
              sb_out_pos == 0);

        // ---- 4. 复位后无残留 valid ----
        i_rst = 1'b1;
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        repeat (8) @(negedge i_clk);
        check("复位后 o_valid 应为 0", o_valid == 1'b0);

        if (errors == 0) begin
            $display("RESULT: PASS - tb_fft64_reorder, 0 errors (位反序->自然序/侧带/乒乓 全部通过)");
            $finish;
        end else begin
            $fatal(1, "TB_FAIL: tb_fft64_reorder %0d 项判据失败", errors);
        end
    end

endmodule

`default_nettype wire
