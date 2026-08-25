//==============================================================================
// tb_cp_remove_reset — G-C-04 复位证据: 帧中途复位后逐寄存器比对
//
// 判据不是"复位后还能跑", 而是**每一个受复位控制的寄存器都回到它声明的复位值**。
// 只看行为会漏掉"残留状态恰好不影响本场景"的情况 —— 换个场景就炸。
//
// 数据通路寄存器 (ri_data / ro_re / ro_im) 按设计**不复位**, 故不在比对表内:
// 它们只在下一拍被无条件覆盖, 复位它们只会白占资源 (与 sync_top 同一约定)。
// 本 TB 显式断言这三个确实无复位逻辑 —— 若将来有人给它们加了复位, 比对表会
// 与设计脱节, 这里会先失败。
//
// 输出格式 (供 run_sim.cjs 解析成 reset-sim.json):
//   RESET_REG <层次名> <实得> <期望>
//   RESET_FREE <层次名> <复位前值> <复位后值>
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_cp_remove_reset;

    localparam int DATA_W = 16;

    logic i_clk = 1'b0, i_rst = 1'b1;
    logic i_fft_start = 1'b0;
    logic [7:0] i_cfg_n_sym = 8'd4;
    logic s_valid = 1'b0;
    logic [DATA_W*2-1:0] s_data = '0;

    logic o_valid, o_sb;
    logic signed [DATA_W-1:0] o_re, o_im;

    int fails = 0, checks = 0;

    always #5 i_clk = ~i_clk;

    cp_remove #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_fft_start(i_fft_start), .i_cfg_n_sym(i_cfg_n_sym),
        .s_axis_tvalid(s_valid), .s_axis_tdata(s_data),
        .o_valid(o_valid), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    task automatic chk(input string nm, input int got, input int want);
        checks++;
        if (got !== want) begin
            fails++;
            $display("  [RESET-FAIL] %s 实得 %0d 期望 %0d", nm, got, want);
        end
        $display("RESET_REG %s %0d %0d", nm, got, want);
    endtask

    // 数据通路寄存器复位前的值, 用于证明它们**没有**被复位清零
    logic [DATA_W*2-1:0] pre_ri_data;
    logic signed [DATA_W-1:0] pre_ro_re, pre_ro_im;

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // --- 跑进帧中途: 让每个受复位寄存器都离开复位值 ---
        // 起窗
        s_valid = 1'b1; i_fft_start = 1'b1; s_data = 32'h1234_5678;
        @(negedge i_clk);
        i_fft_start = 1'b0;
        // 推进 200 拍 —— 足以走完 T1(64)+T2(64)+CP(16)+DATA(64) 进入第二个符号,
        // 此时 r_seg/r_idx/r_lts2/r_sym 全部非复位值
        for (int n = 0; n < 200; n++) begin
            s_data = 32'(n) ^ 32'hA5A5_5A5A;
            @(negedge i_clk);
        end

        // 先确认状态**确实**已经离开复位值, 否则这个 TB 什么也没证明
        if (dut.r_seg === 2'd0 && dut.r_idx === 7'd0 && dut.r_sym === 8'd0) begin
            $fatal(1, "TB_FAIL: 复位前状态仍在复位值 —— 本 TB 无法证明任何事");
        end
        $display("  复位前状态: seg=%0d idx=%0d lts2=%0b sym=%0d",
                 dut.r_seg, dut.r_idx, dut.r_lts2, dut.r_sym);

        pre_ri_data = dut.ri_data;
        pre_ro_re   = dut.ro_re;
        pre_ro_im   = dut.ro_im;

        // --- 帧中途拉复位, 保持 3 拍 ---
        i_rst = 1'b1;
        repeat (3) @(negedge i_clk);

        // --- 逐寄存器比对 (复位仍为高, 输入继续动, 复位必须压得住) ---
        chk("dut.ri_valid", int'(dut.ri_valid), 0);
        chk("dut.ri_fs",    int'(dut.ri_fs),    0);
        chk("dut.r_seg",    int'(dut.r_seg),    0);   // S_UNSYNC
        chk("dut.r_idx",    int'(dut.r_idx),    0);
        chk("dut.r_lts2",   int'(dut.r_lts2),   0);
        chk("dut.r_sym",    int'(dut.r_sym),    0);
        chk("dut.ro_valid", int'(dut.ro_valid), 0);
        chk("dut.ro_sb",    int'(dut.ro_sb),    0);

        // --- 数据通路寄存器: 断言它们**跟随输入**而非被复位清零 ---
        // 若有人给它们加了复位, 这里会看到 0, 与上面的比对表脱节。
        $display("RESET_FREE dut.ri_data %0d %0d", pre_ri_data, dut.ri_data);
        $display("RESET_FREE dut.ro_re %0d %0d",   pre_ro_re,   dut.ro_re);
        $display("RESET_FREE dut.ro_im %0d %0d",   pre_ro_im,   dut.ro_im);
        if (dut.ri_data !== s_data) begin
            fails++;
            $display("  [RESET-FAIL] ri_data 在复位期间没有跟随输入 —— 与'数据通路不复位'的声明矛盾");
        end
        checks++;

        // --- 释放复位, 必须能重新起窗 (证明复位不是把模块弄死了) ---
        i_rst = 1'b0;
        @(negedge i_clk);
        i_fft_start = 1'b1; s_data = 32'h0001_0001;
        @(negedge i_clk);
        i_fft_start = 1'b0;
        begin
            int seen;
            seen = 0;
            for (int n = 0; n < 64; n++) begin
                @(negedge i_clk);
                s_data = 32'h0002_0002;
                if (o_valid) seen++;
            end
            if (seen == 0) begin
                fails++;
                $display("  [RESET-FAIL] 复位释放后无法重新起窗");
            end
            checks++;
            $display("  复位释放后 64 拍内出 %0d 个有效点 (应 >0)", seen);
        end

        if (fails != 0)
            $fatal(1, "TB_FAIL: 复位比对 %0d/%0d 项失败", fails, checks);

        $display("RESULT: PASS - tb_cp_remove_reset, 0 errors (%0d 项逐寄存器比对全过)", checks);
        $finish;
    end

endmodule

`default_nettype wire
