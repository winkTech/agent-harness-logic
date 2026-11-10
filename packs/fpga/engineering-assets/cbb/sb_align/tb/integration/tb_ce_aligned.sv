//==============================================================================
// tb_ce_aligned — 判据 TB: sb_align 是否真的把 372/384 的差异打到零?
//
// 与 tb_ce_fslead 同一套激励、同一个参考, 只把 B 跑法换成"经 sb_align":
//   A  frame_start 人工领先 1 拍 (channel_est 的文档契约) -> 参考
//   B  frame_start 与样点同拍 (fft64 的 o_sb 实际时序) 送进 **sb_align**, 由它适配
// 判据: B 的 H 输出必须与 A **逐点相同**。这才叫"解决了", 而不是"看起来能跑"。
//
// 必须用 xsim (iverilog 编译不了 channel_est_top)。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_ce_aligned;

    localparam int DATA_W = 16;
    localparam int N      = 64;
    localparam int NSYM   = 6;
    localparam int MAXO   = 4096;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    //--------------------------------------------------------------------------
    // 被测: channel_est_top, 其 frame_start / s_axis 由下面两种方式驱动
    //--------------------------------------------------------------------------
    logic ce_fs, ce_tvalid, ce_tready;
    logic [DATA_W*2-1:0] ce_tdata;
    logic m_valid;
    logic [DATA_W*2-1:0] m_data;

    channel_est_top #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_frame_start(ce_fs),
        .s_axis_tvalid(ce_tvalid), .s_axis_tready(ce_tready), .s_axis_tdata(ce_tdata),
        .m_axis_tvalid(m_valid), .m_axis_tready(1'b1), .m_axis_tdata(m_data));

    //--------------------------------------------------------------------------
    // 直驱通路 (A 用) 与 sb_align 通路 (B 用), 由 use_align 选择
    //--------------------------------------------------------------------------
    bit use_align = 1'b0;

    // 原始推流 (模拟 fft64 的输出: o_sb 与首个输出同拍)
    logic src_valid = 1'b0, src_sb = 1'b0;
    logic signed [DATA_W-1:0] src_re = '0, src_im = '0;

    // A 通路的人工领先一拍
    logic manual_fs = 1'b0;

    logic al_fs, al_tvalid, al_ovf;
    logic [DATA_W*2-1:0] al_tdata;

    sb_align #(.DATA_W(DATA_W), .P_DEPTH(4)) u_align (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(src_valid), .i_re(src_re), .i_im(src_im), .i_sb(src_sb),
        .o_frame_start(al_fs),
        .m_axis_tvalid(al_tvalid), .m_axis_tready(ce_tready), .m_axis_tdata(al_tdata),
        .o_overflow(al_ovf));

    assign ce_fs     = use_align ? al_fs     : manual_fs;
    assign ce_tvalid = use_align ? al_tvalid : src_valid;
    assign ce_tdata  = use_align ? al_tdata  : {src_im, src_re};

    //--------------------------------------------------------------------------
    int  cap [0:MAXO-1];
    int  cap_n = 0;
    bit  capture = 1'b0;

    always @(posedge i_clk) begin
        if (!i_rst && m_valid && capture && cap_n < MAXO) begin
            cap[cap_n] <= int'(m_data);
            cap_n      <= cap_n + 1;
        end
    end

    function automatic int unsigned samp(input int idx);
        samp = ((idx * 37 + 11) % 3000);
    endfunction

    // 直驱通路要尊重 tready; sb_align 通路上游不可停顿, 但本 TB 的 tready 恒高
    task automatic push(input int idx, input bit sb);
        src_valid = 1'b1; src_sb = sb;
        src_re = DATA_W'(samp(idx) % 1500); src_im = DATA_W'(samp(idx));
        @(negedge i_clk);
        while (!use_align && !ce_tready) @(negedge i_clk);
    endtask

    task automatic rst_pulse();
        @(negedge i_clk); src_valid = 1'b0; src_sb = 1'b0; manual_fs = 1'b0;
        i_rst = 1'b1; repeat (4) @(negedge i_clk); i_rst = 1'b0;
        @(negedge i_clk);
        cap_n = 0;
    endtask

    int ref_n, diff;
    int ref_h [0:MAXO-1];

    initial begin
        //----------------------------------------------------------------------
        // A: 直驱 + 人工领先一拍 (参考)
        //----------------------------------------------------------------------
        use_align = 1'b0;
        rst_pulse();
        capture = 1'b1;
        manual_fs = 1'b1; @(negedge i_clk); manual_fs = 1'b0;
        for (int k = 0; k < (2 + NSYM) * N; k++) push(k, 1'b0);
        @(negedge i_clk); src_valid = 1'b0;
        repeat (2000) @(negedge i_clk);
        capture = 1'b0;
        ref_n = cap_n;
        for (int k = 0; k < ref_n && k < MAXO; k++) ref_h[k] = cap[k];
        $display("ALIGNED_REF_OUT %0d", ref_n);

        //----------------------------------------------------------------------
        // B: 经 sb_align, sb 与样点同拍 (fft64 的真实时序)
        //----------------------------------------------------------------------
        use_align = 1'b1;
        rst_pulse();
        capture = 1'b1;
        for (int k = 0; k < (2 + NSYM) * N; k++) push(k, (k == 0));
        @(negedge i_clk); src_valid = 1'b0;
        repeat (2000) @(negedge i_clk);
        capture = 1'b0;
        $display("ALIGNED_B_OUT %0d", cap_n);
        $display("ALIGNED_OVERFLOW %0b", al_ovf);

        //----------------------------------------------------------------------
        diff = 0;
        if (cap_n != ref_n) begin
            $display("ALIGNED_DIFF_COUNT %0d", cap_n - ref_n);
            diff = -1;
        end else begin
            for (int k = 0; k < ref_n; k++) if (cap[k] != ref_h[k]) diff++;
            $display("ALIGNED_DIFF_COUNT 0");
        end
        $display("ALIGNED_DIFF_POINTS %0d", diff);

        if (al_ovf !== 1'b0)
            $fatal(1, "TB_FAIL: sb_align 在本场景下溢出了 —— 深度不足");
        if (cap_n != ref_n)
            $fatal(1, "TB_FAIL: 经 sb_align 后输出 %0d 点, 参考 %0d 点", cap_n, ref_n);
        if (diff != 0)
            $fatal(1, "TB_FAIL: 经 sb_align 后仍有 %0d/%0d 点与参考不同", diff, ref_n);

        $display("RESULT: PASS - tb_ce_aligned, 0 errors (经 sb_align 后 %0d 点逐点等于正确时机的参考)", ref_n);
        $finish;
    end

endmodule

`default_nettype wire
