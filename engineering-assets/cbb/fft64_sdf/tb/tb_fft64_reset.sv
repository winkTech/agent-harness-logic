//==============================================================================
// tb_fft64_reset — G-C-04 复位证据: 流水跑满后复位, 逐寄存器比对
//
// 判据不是"复位后还能跑", 而是**每一个受复位控制的寄存器都回到它声明的复位值**。
// 只看行为会漏掉"残留状态恰好不影响本场景"的情况。
//
// 本模块的复位策略是刻意分层的 (docs/limitations.md 6):
//   受复位   —— 所有 valid/计数/状态位 (下面逐个比对)
//   不复位   —— 数据通路与各级 FIFO/存储 (利于 BRAM/SRL 宏吸收)
// 因此复位后第一个符号仍会带出未初始化值, 必须预热一个符号 —— 这不是缺陷,
// 是与"FIFO 不复位"配套的使用契约。本 TB 显式验证这一点: 复位后**控制位全清**
// 且**能重新跑出正确长度的输出**。
//
// 输出格式 (供 run_sim.cjs 解析成 reset-sim.json):
//   RESET_REG <层次名> <实得> <期望>
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_reset;

    localparam int DATA_W = 16;

    logic i_clk = 1'b0, i_rst = 1'b1, i_beat = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_valid, o_sb;
    logic [5:0] o_idx;
    logic signed [DATA_W-1:0] o_re, o_im;

    int fails = 0, checks = 0;
    int outs = 0;

    always #5 i_clk = ~i_clk;

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b1)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(o_valid), .o_idx(o_idx), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    always @(posedge i_clk) if (!i_rst && o_valid) outs <= outs + 1;

    task automatic chk(input string nm, input int got, input int want);
        checks++;
        if (got !== want) begin
            fails++;
            $display("  [RESET-FAIL] %s 实得 %0d 期望 %0d", nm, got, want);
        end
        $display("RESET_REG %s %0d %0d", nm, got, want);
    endtask

    task automatic feed(input int n);
        for (int k = 0; k < n; k++) begin
            @(negedge i_clk);
            i_valid = 1'b1;
            i_sb    = ((k % 64) == 0);
            i_re    = DATA_W'(1000 + (k % 37) * 13);
            i_im    = DATA_W'(-500 + (k % 29) * 7);
        end
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // --- 把流水灌满: 6 个符号 = 384 拍, 远超总延迟 75 拍 ---
        feed(6 * 64);

        // 确认状态确实已经离开复位值, 否则这个 TB 什么也没证明
        if (dut.u_core.ri_valid === 1'b0 && dut.u_core.r_ocnt === 6'd0) begin
            $fatal(1, "TB_FAIL: 复位前流水仍是空的 —— 本 TB 无法证明任何事");
        end
        $display("  复位前: core.r_ocnt=%0d core.ri_valid=%0b 已出 %0d 点",
                 dut.u_core.r_ocnt, dut.u_core.ri_valid, outs);

        // --- 拉复位, 保持 3 拍; 输入继续动, 复位必须压得住 ---
        i_rst = 1'b1;
        repeat (3) @(negedge i_clk);

        // ---- core: 输入寄存 ----
        chk("dut.u_core.ri_valid", int'(dut.u_core.ri_valid), 0);
        chk("dut.u_core.ri_sb",    int'(dut.u_core.ri_sb),    0);

        // ---- core: 6 个 SDF 级的计数/预热/输出有效 ----
        chk("dut.u_core.g_stage[1].r_cnt",  int'(dut.u_core.g_stage[1].r_cnt),  0);
        chk("dut.u_core.g_stage[1].r_warm", int'(dut.u_core.g_stage[1].r_warm), 0);
        chk("dut.u_core.g_stage[1].ro_v",   int'(dut.u_core.g_stage[1].ro_v),   0);
        chk("dut.u_core.g_stage[2].r_cnt",  int'(dut.u_core.g_stage[2].r_cnt),  0);
        chk("dut.u_core.g_stage[2].r_warm", int'(dut.u_core.g_stage[2].r_warm), 0);
        chk("dut.u_core.g_stage[2].ro_v",   int'(dut.u_core.g_stage[2].ro_v),   0);
        chk("dut.u_core.g_stage[3].r_cnt",  int'(dut.u_core.g_stage[3].r_cnt),  0);
        chk("dut.u_core.g_stage[3].r_warm", int'(dut.u_core.g_stage[3].r_warm), 0);
        chk("dut.u_core.g_stage[3].ro_v",   int'(dut.u_core.g_stage[3].ro_v),   0);
        chk("dut.u_core.g_stage[4].r_cnt",  int'(dut.u_core.g_stage[4].r_cnt),  0);
        chk("dut.u_core.g_stage[4].r_warm", int'(dut.u_core.g_stage[4].r_warm), 0);
        chk("dut.u_core.g_stage[4].ro_v",   int'(dut.u_core.g_stage[4].ro_v),   0);
        chk("dut.u_core.g_stage[5].r_cnt",  int'(dut.u_core.g_stage[5].r_cnt),  0);
        chk("dut.u_core.g_stage[5].r_warm", int'(dut.u_core.g_stage[5].r_warm), 0);
        chk("dut.u_core.g_stage[5].ro_v",   int'(dut.u_core.g_stage[5].ro_v),   0);
        chk("dut.u_core.g_stage[6].r_cnt",  int'(dut.u_core.g_stage[6].r_cnt),  0);
        chk("dut.u_core.g_stage[6].r_warm", int'(dut.u_core.g_stage[6].r_warm), 0);
        chk("dut.u_core.g_stage[6].ro_v",   int'(dut.u_core.g_stage[6].ro_v),   0);

        // ---- core: 两个复乘的相位计数与 valid 流水 ----
        chk("dut.u_core.g_mult[0].r_cnt", int'(dut.u_core.g_mult[0].r_cnt), 0);
        chk("dut.u_core.g_mult[0].r_v1",  int'(dut.u_core.g_mult[0].r_v1),  0);
        chk("dut.u_core.g_mult[0].r_v2",  int'(dut.u_core.g_mult[0].r_v2),  0);
        chk("dut.u_core.g_mult[0].r_v3",  int'(dut.u_core.g_mult[0].r_v3),  0);
        chk("dut.u_core.g_mult[1].r_cnt", int'(dut.u_core.g_mult[1].r_cnt), 0);
        chk("dut.u_core.g_mult[1].r_v1",  int'(dut.u_core.g_mult[1].r_v1),  0);
        chk("dut.u_core.g_mult[1].r_v2",  int'(dut.u_core.g_mult[1].r_v2),  0);
        chk("dut.u_core.g_mult[1].r_v3",  int'(dut.u_core.g_mult[1].r_v3),  0);

        // ---- core: 侧带延迟线 (75 拍移位寄存器, 必须整条清零) ----
        chk("dut.u_core.r_sbq", int'(dut.u_core.r_sbq), 0);

        // ---- core: 输出级 ----
        chk("dut.u_core.ro_valid", int'(dut.u_core.ro_valid), 0);
        chk("dut.u_core.r_ocnt",   int'(dut.u_core.r_ocnt),   0);
        chk("dut.u_core.ro_idx",   int'(dut.u_core.ro_idx),   0);
        chk("dut.u_core.ro_sb",    int'(dut.u_core.ro_sb),    0);

        // ---- reorder: 写侧 / 读侧 / 输出级 ----
        chk("dut.g_natural.u_reorder.r_wbank",   int'(dut.g_natural.u_reorder.r_wbank),   0);
        chk("dut.g_natural.u_reorder.r_sb_pend", int'(dut.g_natural.u_reorder.r_sb_pend), 0);
        chk("dut.g_natural.u_reorder.r_ractive", int'(dut.g_natural.u_reorder.r_ractive), 0);
        chk("dut.g_natural.u_reorder.r_rcnt",    int'(dut.g_natural.u_reorder.r_rcnt),    0);
        chk("dut.g_natural.u_reorder.r_rbank",   int'(dut.g_natural.u_reorder.r_rbank),   0);
        chk("dut.g_natural.u_reorder.r_sb_rd",   int'(dut.g_natural.u_reorder.r_sb_rd),   0);
        chk("dut.g_natural.u_reorder.ro_valid",  int'(dut.g_natural.u_reorder.ro_valid),  0);
        chk("dut.g_natural.u_reorder.ro_sb",     int'(dut.g_natural.u_reorder.ro_sb),     0);

        // ---- 复位期间输出必须静默 ----
        if (o_valid !== 1'b0) begin
            fails++; $display("  [RESET-FAIL] 复位期间 o_valid 仍为高");
        end
        checks++;

        // --- 释放复位: 预热一个符号后, 输出长度必须恢复正常 ---
        // (数据通路/FIFO 按设计不复位, 首符号带未初始化值 —— 见 limitations 6)
        i_rst = 1'b0;
        @(negedge i_clk);
        outs = 0;
        feed(64);                       // 预热符号
        feed(4 * 64);                   // 正式 4 个符号
        for (int k = 0; k < 256; k++) begin   // 冲刷, 64 的整数倍
            @(negedge i_clk);
            i_valid = 1'b1; i_sb = 1'b0; i_re = '0; i_im = '0;
        end
        @(negedge i_clk); i_valid = 1'b0;
        repeat (200) @(negedge i_clk);

        // 预热 + 4 个符号 + 冲刷 4 个零符号 = 9 个符号进, 出的点数应是 64 的整数倍且 >= 5*64
        if (outs % 64 != 0 || outs < 5 * 64) begin
            fails++;
            $display("  [RESET-FAIL] 复位释放后输出 %0d 点 (应为 64 的整数倍且 >= %0d)", outs, 5*64);
        end
        checks++;
        $display("  复位释放后重新跑出 %0d 点 (64 的整数倍)", outs);

        if (fails != 0)
            $fatal(1, "TB_FAIL: 复位比对 %0d/%0d 项失败", fails, checks);

        $display("RESULT: PASS - tb_fft64_reset, 0 errors (%0d 项逐寄存器比对全过)", checks);
        $finish;
    end

endmodule

`default_nettype wire
