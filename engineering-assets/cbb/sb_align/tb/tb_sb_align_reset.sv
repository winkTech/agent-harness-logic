//==============================================================================
// tb_sb_align_reset — G-C-04 复位证据: 跑起来之后复位, 逐寄存器比对
//
// 判据不是"复位后还能跑", 而是**每一个受复位控制的寄存器都回到它声明的复位值**。
// 只看行为会漏掉"残留状态恰好不影响本场景"的情况。
//
// 存储阵列 r_mem 按设计**不复位** —— 它只在写指针推进时被覆写, 读侧永远只读已写过
// 的槽 (由 w_empty 保证), 复位它只会白占资源。本 TB 显式记录这一点, 并断言复位期间
// 它确实保持不变 (而不是被清零), 以防将来有人加了复位却不更新比对表。
//
// 输出格式 (供 run_sim.cjs 解析成 reset-sim.json):
//   RESET_REG <层次名> <实得> <期望>
//   RESET_FREE <层次名> <复位前值> <复位后值>
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_sb_align_reset;

    localparam int DATA_W  = 16;
    localparam int P_DEPTH = 4;

    logic i_clk = 1'b0, i_rst = 1'b1;
    logic i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_frame_start, m_axis_tvalid, o_overflow;
    logic m_axis_tready = 1'b0;                 // 刻意不收, 好把 FIFO 堆起来
    logic [DATA_W*2-1:0] m_axis_tdata;

    int fails = 0, checks = 0;

    // 真实计数: r_rd 是会回绕的指针 (深度 4 -> 3 位), 不能拿来当"送出了多少"
    int accepted = 0;

    always #5 i_clk = ~i_clk;

    always @(posedge i_clk)
        if (!i_rst && m_axis_tvalid && m_axis_tready) accepted <= accepted + 1;

    sb_align #(.DATA_W(DATA_W), .P_DEPTH(P_DEPTH)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(i_valid), .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_frame_start(o_frame_start),
        .m_axis_tvalid(m_axis_tvalid), .m_axis_tready(m_axis_tready),
        .m_axis_tdata(m_axis_tdata), .o_overflow(o_overflow));

    task automatic chk(input string nm, input int got, input int want);
        checks++;
        if (got !== want) begin
            fails++;
            $display("  [RESET-FAIL] %s 实得 %0d 期望 %0d", nm, got, want);
        end
        $display("RESET_REG %s %0d %0d", nm, got, want);
    endtask

    task automatic push(input int idx, input bit sb);
        @(negedge i_clk);
        i_valid = 1'b1; i_sb = sb;
        i_re = DATA_W'(idx); i_im = DATA_W'(-idx);
    endtask

    logic [DATA_W*2:0] pre_mem0, pre_mem1;
    int seen;

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // --- 跑到一个"状态尽可能不为复位值"的点 ---
        // 下游不收 + 灌超深度 -> 写指针推进、溢出置起、队头带 sb 已报过
        for (int k = 0; k < P_DEPTH + 6; k++) push(3000 + k, (k == 0));
        @(negedge i_clk); i_valid = 1'b0;
        repeat (4) @(negedge i_clk);

        if (dut.r_wr === '0 && dut.ro_ovf === 1'b0) begin
            $fatal(1, "TB_FAIL: 复位前状态仍在复位值 —— 本 TB 无法证明任何事");
        end
        $display("  复位前: r_wr=%0d r_rd=%0d announced=%0b ovf=%0b fs=%0b tvalid=%0b",
                 dut.r_wr, dut.r_rd, dut.r_announced, dut.ro_ovf, dut.ro_fs, dut.ro_tvalid);

        pre_mem0 = dut.r_mem[0];
        pre_mem1 = dut.r_mem[1];

        // --- 拉复位保持 3 拍; 输入继续动, 复位必须压得住 ---
        i_rst = 1'b1;
        i_valid = 1'b1; i_re = 16'sh1234; i_im = 16'sh5678; i_sb = 1'b1;
        repeat (3) @(negedge i_clk);

        chk("dut.r_wr",        int'(dut.r_wr),        0);
        chk("dut.r_rd",        int'(dut.r_rd),        0);
        chk("dut.r_announced", int'(dut.r_announced), 0);
        chk("dut.ro_ovf",      int'(dut.ro_ovf),      0);
        chk("dut.ro_fs",       int'(dut.ro_fs),       0);
        chk("dut.ro_tvalid",   int'(dut.ro_tvalid),   0);
        chk("dut.ro_tdata",    int'(dut.ro_tdata),    0);

        // --- 存储阵列按设计不复位: 断言它保持不变而非被清零 ---
        $display("RESET_FREE dut.r_mem[0] %0d %0d", pre_mem0, dut.r_mem[0]);
        $display("RESET_FREE dut.r_mem[1] %0d %0d", pre_mem1, dut.r_mem[1]);
        if (dut.r_mem[0] !== pre_mem0 || dut.r_mem[1] !== pre_mem1) begin
            fails++;
            $display("  [RESET-FAIL] r_mem 在复位期间被改动 —— 与'存储阵列不复位'的声明矛盾");
        end
        checks++;

        // --- 复位期间输出必须静默 ---
        if (m_axis_tvalid !== 1'b0 || o_frame_start !== 1'b0) begin
            fails++; $display("  [RESET-FAIL] 复位期间输出未静默");
        end
        checks++;

        // --- 释放复位, 必须能重新工作 ---
        // 先把 i_valid 撤掉再释放复位 —— 否则复位期间那一拍的毒值会被当成真样点写进去
        i_valid = 1'b0;
        @(negedge i_clk);
        i_rst = 1'b0;
        m_axis_tready = 1'b1;
        @(negedge i_clk);
        accepted = 0;
        for (int k = 0; k < 64; k++) push(9000 + k, (k == 0));
        @(negedge i_clk); i_valid = 1'b0;
        repeat (20) @(negedge i_clk);
        seen = accepted;
        if (seen != 64) begin
            fails++;
            $display("  [RESET-FAIL] 复位释放后应送出 64 个样点, 实为 %0d", seen);
        end
        checks++;
        chk("dut.ro_ovf (复位后重跑, 下游收数, 不应再溢出)", int'(dut.ro_ovf), 0);
        $display("  复位释放后送出 %0d 个样点 (期望 64)", seen);

        if (fails != 0)
            $fatal(1, "TB_FAIL: 复位比对 %0d/%0d 项失败", fails, checks);

        $display("RESULT: PASS - tb_sb_align_reset, 0 errors (%0d 项逐寄存器比对全过)", checks);
        $finish;
    end

endmodule

`default_nettype wire
