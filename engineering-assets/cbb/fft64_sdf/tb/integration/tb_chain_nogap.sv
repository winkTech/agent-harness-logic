//==============================================================================
// tb_chain_nogap — **对抗测量**: 把 CP 间隙拿掉, 看 channel_est_top 会不会反压、
// 需要多深的缓冲。
//
// 动因: tb_chain_depth 在真实 802.11a 链路 (cp_remove 每 80 拍给 64 拍有效,
// 天然留 16 拍空档) 下测得 channel_est **零反压**、缓冲峰值占用 1。那么"必须有
// 弹性缓冲"这条到底是不是真的? 本 TB 去掉那 16 拍空档 —— 直接给 fft64 灌背靠背
// 的连续符号 —— 构造出 CP 间隙不存在时的上界。
//
// 这不是 M1 会出现的工况 (CP 是 802.11a 帧结构的一部分), 而是用来回答:
// "如果哪天上游节奏变了, 缓冲要多深"。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_chain_nogap;

    localparam int DATA_W   = 16;
    localparam int NSYM     = 12;      // 连续数据符号数 (前 2 个当 LTS)
    localparam int FIFO_MAX = 65536;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    // fft64 直驱, 无 CP 间隙
    logic ff_i_valid = 1'b0, ff_i_sb = 1'b0;
    logic signed [DATA_W-1:0] ff_i_re = '0, ff_i_im = '0;

    logic ff_o_valid, ff_o_sb;
    logic [5:0] ff_o_idx;
    logic signed [DATA_W-1:0] ff_o_re, ff_o_im;

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b1)) u_fft (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(1'b1), .i_valid(ff_i_valid),
        .i_re(ff_i_re), .i_im(ff_i_im), .i_sb(ff_i_sb),
        .o_valid(ff_o_valid), .o_idx(ff_o_idx),
        .o_re(ff_o_re), .o_im(ff_o_im), .o_sb(ff_o_sb));

    // 理想无限深 FIFO
    logic [DATA_W*2-1:0] fifo_d  [0:FIFO_MAX-1];
    bit                  fifo_sb [0:FIFO_MAX-1];
    int wr = 0, rd = 0, peak = 0;
    logic r_fs_done = 1'b0;

    logic ce_s_valid, ce_s_ready, ce_fs;
    logic [DATA_W*2-1:0] ce_s_data;

    assign ce_s_valid = (wr > rd);
    assign ce_s_data  = (wr > rd) ? fifo_d[rd % FIFO_MAX] : '0;
    assign ce_fs      = (wr > rd) && fifo_sb[rd % FIFO_MAX] && !r_fs_done;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            wr <= 0; rd <= 0; peak <= 0; r_fs_done <= 1'b0;
        end else begin
            if (ff_o_valid) begin
                fifo_d[wr % FIFO_MAX]  <= {ff_o_im, ff_o_re};
                fifo_sb[wr % FIFO_MAX] <= ff_o_sb;
                wr <= wr + 1;
            end
            if (ce_s_valid && ce_s_ready) begin
                rd <= rd + 1;
                if (fifo_sb[rd % FIFO_MAX]) r_fs_done <= 1'b1;
            end
            if ((wr - rd) > peak) peak <= wr - rd;
        end
    end

    logic ce_m_valid;
    logic [DATA_W*2-1:0] ce_m_data;

    channel_est_top #(.DATA_W(DATA_W)) u_ce (
        .i_clk(i_clk), .i_rst(i_rst), .i_frame_start(ce_fs),
        .s_axis_tvalid(ce_s_valid), .s_axis_tready(ce_s_ready), .s_axis_tdata(ce_s_data),
        .m_axis_tvalid(ce_m_valid), .m_axis_tready(1'b1), .m_axis_tdata(ce_m_data));

    int stall_total = 0, stall_run = 0, stall_max = 0;
    int ff_beats = 0, ce_beats = 0, ce_out = 0;

    always_ff @(posedge i_clk) begin
        if (!i_rst) begin
            if (ff_o_valid) ff_beats <= ff_beats + 1;
            if (ce_s_valid && ce_s_ready) ce_beats <= ce_beats + 1;
            if (ce_m_valid) ce_out <= ce_out + 1;
            if (ce_s_valid && !ce_s_ready) begin
                stall_total <= stall_total + 1;
                stall_run   <= stall_run + 1;
                if (stall_run + 1 > stall_max) stall_max <= stall_run + 1;
            end else stall_run <= 0;
        end
    end

    task automatic push(input int re, input int im, input bit sb);
        @(negedge i_clk);
        ff_i_valid = 1'b1; ff_i_sb = sb;
        ff_i_re = DATA_W'(re); ff_i_im = DATA_W'(im);
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // 预热符号 (fft64 的 FIFO 不复位, 首符号带未初始化值)
        for (int k = 0; k < 64; k++) push(0, 0, (k == 0));

        // 背靠背连续符号, **零间隙**
        for (int s = 0; s < NSYM; s++)
            for (int k = 0; k < 64; k++)
                push(((s*37 + k*11) % 3000) - 1500,
                     ((s*53 + k*7)  % 3000) - 1500, (k == 0));

        // 冲刷 (64 整数倍)
        for (int k = 0; k < 4*64; k++) push(0, 0, 1'b0);
        @(negedge i_clk); ff_i_valid = 1'b0;
        repeat (1200) @(negedge i_clk);

        $display("NOGAP FF_BEATS %0d", ff_beats);
        $display("NOGAP CE_BEATS %0d", ce_beats);
        $display("NOGAP CE_OUT %0d", ce_out);
        $display("NOGAP DEPTH_PEAK %0d", peak);
        $display("NOGAP STALL_TOTAL %0d", stall_total);
        $display("NOGAP STALL_MAX_RUN %0d", stall_max);
        $display("RESULT: PASS - tb_chain_nogap (对抗测量 TB, 不含判据)");
        $finish;
    end

endmodule

`default_nettype wire
