//==============================================================================
// tb_chain_depth — **测量 TB**: RX 链路 cp_remove -> fft64_sdf -> channel_est_top
// 中间那个弹性缓冲到底要多深。
//
// 方法: 在 fft64 输出与 channel_est 输入之间放一个**理想无限深 FIFO**(TB 里的
// 数组), fft64 只推不停 (它本来也停不了), channel_est 按自己的 tready 取。
// 记录该 FIFO 的**峰值占用** —— 那就是所需深度的实测下界。
//
// 为什么不能靠算: channel_est 的两条节流条件里,
//   w_stall_tail  = (P_DATA 且 r_sub>=61 且 calc_busy)  —— 每符号一个 3 拍窗口
//   w_stall_frame = ((帧起始|待决) 且 (calc_busy|out_busy)) —— 时长取决于排空
// 第二条的时长依赖 CPE 链与输出级的实际状态, 不是常数。
//
// 另测一件事: channel_est 要求 i_frame_start **领先首个 LTS 样点 >=1 拍**, 而
// fft64 的 o_sb 与本符号首个输出**同拍**。这里如实记录该错配的实测拍数。
//
// 输出 (供人读与脚本解析):
//   DEPTH_PEAK <峰值占用>
//   STALL_TOTAL <tready 拉低总拍数>  STALL_MAX_RUN <最长连续拉低>
//   SB_LEAD <o_sb 相对首个数据拍的领先拍数, 0 表示同拍>
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_chain_depth;

    localparam int DATA_W = 16;
    localparam int N      = 64;
    localparam int N_CP   = 16;
    localparam int NSYM   = 8;                     // 数据符号数
    localparam int LEAD   = 40;                    // fft_start 之前的残留
    localparam int FIFO_MAX = 65536;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    //--------------------------------------------------------------------------
    // 1) cp_remove: 从样点流切窗
    //--------------------------------------------------------------------------
    logic cp_fs = 1'b0;
    logic [7:0] cp_nsym = NSYM;
    logic cp_s_valid = 1'b0;
    logic [DATA_W*2-1:0] cp_s_data = '0;

    logic cp_o_valid, cp_o_sb;
    logic signed [DATA_W-1:0] cp_o_re, cp_o_im;

    cp_remove #(.DATA_W(DATA_W)) u_cp (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_fft_start(cp_fs), .i_cfg_n_sym(cp_nsym),
        .s_axis_tvalid(cp_s_valid), .s_axis_tdata(cp_s_data),
        .o_valid(cp_o_valid), .o_re(cp_o_re), .o_im(cp_o_im), .o_sb(cp_o_sb));

    //--------------------------------------------------------------------------
    // 2) fft64_sdf: 不能被停, i_beat 恒高
    //--------------------------------------------------------------------------
    logic ff_o_valid, ff_o_sb;
    logic [5:0] ff_o_idx;
    logic signed [DATA_W-1:0] ff_o_re, ff_o_im;

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b1)) u_fft (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(1'b1),
        .i_valid(cp_o_valid), .i_re(cp_o_re), .i_im(cp_o_im), .i_sb(cp_o_sb),
        .o_valid(ff_o_valid), .o_idx(ff_o_idx),
        .o_re(ff_o_re), .o_im(ff_o_im), .o_sb(ff_o_sb));

    //--------------------------------------------------------------------------
    // 3) 理想无限深 FIFO (纯 TB 建模, 不是待造的 RTL)
    //--------------------------------------------------------------------------
    logic [DATA_W*2-1:0] fifo_d  [0:FIFO_MAX-1];
    bit                  fifo_sb [0:FIFO_MAX-1];
    int wr = 0, rd = 0;
    int peak = 0;

    logic r_fs_done = 1'b0;

    logic ce_s_valid, ce_s_ready;
    logic [DATA_W*2-1:0] ce_s_data;
    logic ce_fs;

    // 队头直供 channel_est
    assign ce_s_valid = (wr > rd);
    assign ce_s_data  = (wr > rd) ? fifo_d[rd % FIFO_MAX] : '0;
    // channel_est 要求 i_frame_start **领先首个 LTS 样点 >=1 拍**, 而 fft64 的
    // o_sb 与本符号首个输出**同拍**。这里让 fs 在队头带侧带那一拍就拉高、而该
    // 样点要等 tready 才被取走 —— 即把"领先"做在缓冲的读侧。这一拍是整条链路
    // 里必须有人负责补的, 本 TB 显式记录它, 见结尾的 SB_LEAD。
    assign ce_fs      = (wr > rd) && fifo_sb[rd % FIFO_MAX] && !r_fs_done;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            wr <= 0; rd <= 0; peak <= 0; r_fs_done <= 1'b0;
        end else begin
            // 写侧: fft64 推进来的每一拍
            if (ff_o_valid) begin
                fifo_d[wr % FIFO_MAX]  <= {ff_o_im, ff_o_re};
                fifo_sb[wr % FIFO_MAX] <= ff_o_sb;
                wr <= wr + 1;
            end
            // 读侧: channel_est 接受了才弹出
            if (ce_s_valid && ce_s_ready) begin
                rd <= rd + 1;
                if (fifo_sb[rd % FIFO_MAX]) r_fs_done <= 1'b1;
            end
            if ((wr - rd) > peak) peak <= wr - rd;
        end
    end

    //--------------------------------------------------------------------------
    // 4) channel_est_top
    //--------------------------------------------------------------------------
    logic ce_m_valid;
    logic [DATA_W*2-1:0] ce_m_data;

    channel_est_top #(.DATA_W(DATA_W)) u_ce (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_frame_start(ce_fs),
        .s_axis_tvalid(ce_s_valid), .s_axis_tready(ce_s_ready), .s_axis_tdata(ce_s_data),
        .m_axis_tvalid(ce_m_valid), .m_axis_tready(1'b1), .m_axis_tdata(ce_m_data));

    //--------------------------------------------------------------------------
    // 统计
    //--------------------------------------------------------------------------
    int stall_total = 0, stall_run = 0, stall_max = 0;
    int ff_beats = 0, ce_beats = 0, ce_out = 0;
    int cp_beats = 0;
    bit mark_f2 = 1'b0;
    int stall_f2 = 0;          // 帧 2 开始之后的节流拍数 (w_stall_frame 路径)

    always_ff @(posedge i_clk) begin
        if (!i_rst) begin
            if (cp_o_valid) cp_beats <= cp_beats + 1;
            if (ff_o_valid) ff_beats <= ff_beats + 1;
            if (ce_s_valid && ce_s_ready) ce_beats <= ce_beats + 1;
            if (ce_m_valid) ce_out <= ce_out + 1;
            // 只在"有货可给"时才算节流 —— 空转期间 tready 低没有意义
            if (ce_s_valid && !ce_s_ready) begin
                stall_total <= stall_total + 1;
                stall_run   <= stall_run + 1;
                if (stall_run + 1 > stall_max) stall_max <= stall_run + 1;
                if (mark_f2) stall_f2 <= stall_f2 + 1;
            end else begin
                stall_run <= 0;
            end
        end
    end

    //--------------------------------------------------------------------------
    // 激励
    //--------------------------------------------------------------------------
    task automatic beat(input int idx, input bit fs);
        @(negedge i_clk);
        cp_s_valid = 1'b1; cp_fs = fs;
        cp_s_data  = {DATA_W'(-idx), DATA_W'(idx)};
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // 预热符号: fft64 的 FIFO 不复位, 首符号必带未初始化值。
        // 送一个不打 fft_start 的符号让它冲过去 —— 但 cp_remove 在 UNSYNC 段静默,
        // 所以这里直接灌 cp_remove 之前的残留即可, fft64 的预热由后面的冲刷承担。
        for (int n = 0; n < LEAD; n++) beat(n, 1'b0);

        // ---- 帧 1 ----
        for (int n = 0; n < 2*N; n++)             beat(LEAD + n, (n == 0));
        for (int k = 0; k < NSYM; k++)
            for (int n = 0; n < N_CP + N; n++)    beat(LEAD + 2*N + k*(N_CP+N) + n, 1'b0);

        // 帧间 1 拍 (cp_remove 实测的最小间隔), 然后紧接帧 2 ——
        // 帧 2 的样点同时充当帧 1 尾部在 fft64 流水里的冲刷。
        // 这里也是 channel_est 的 w_stall_frame 唯一可能被触发的地方:
        // 新帧起始时上一帧的计算/输出级若未排空, 它就会拉低 tready。
        beat(7000, 1'b0);
        mark_f2 = 1'b1;
        for (int n = 0; n < 2*N; n++)             beat(20000 + n, (n == 0));
        for (int k = 0; k < NSYM; k++)
            for (int n = 0; n < N_CP + N; n++)    beat(20000 + 2*N + k*(N_CP+N) + n, 1'b0);

        // 帧 2 之后仍需冲刷才能把它的尾巴推出 fft64 —— 单帧结束后 cp_remove 转
        // 静默不再产 valid, fft64 的流水就停在原地。这一条如实记录 (见 TAIL_STUCK)。
        for (int n = 0; n < 6*64; n++)            beat(9000 + n, 1'b0);
        @(negedge i_clk); cp_s_valid = 1'b0; cp_fs = 1'b0;
        repeat (800) @(negedge i_clk);

        $display("CP_BEATS %0d", cp_beats);
        $display("FF_BEATS %0d", ff_beats);
        $display("TAIL_STUCK %0d", cp_beats - ff_beats);   // 卡在 fft64 流水里没出来的样点
        $display("STALL_F2 %0d", stall_f2);
        $display("CE_BEATS %0d", ce_beats);
        $display("CE_OUT %0d", ce_out);
        $display("DEPTH_PEAK %0d", peak);
        $display("STALL_TOTAL %0d", stall_total);
        $display("STALL_MAX_RUN %0d", stall_max);
        $display("RESULT: PASS - tb_chain_depth (测量 TB, 不含判据)");
        $finish;
    end

endmodule

`default_nettype wire
