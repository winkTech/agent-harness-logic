//==============================================================================
// tb_y_depth — **测量 TB**: 均衡器 (eq_zf) 的 Y 路缓冲到底要多深。
//
// 为什么必须实测: channel_est_top.sv 第 16 行写着"数据符号末拍 -> 该符号 H 输出
// 完成约 110 拍"。全仓检索确认这个数字**只存在于那条注释里**, 没有任何测量或推导
// 支撑它。本轮已经在同类问题上栽过两次 —— 弹性缓冲的"硬依赖"和 frame_start 差一拍,
// 都是读文档推断而非实测。所以这一项照抄不得。
//
// 测什么: 均衡器要把 Y(m)[k] 与 H(m)[k] 配对相乘。Y 从 fft64 出来就可用, H 要等
// channel_est 收齐整个符号再算。这中间 Y 必须存着。所需深度 =
//     max over 时间 ( 已产出的数据符号 Y 拍数 - 已产出的 H 拍数 )
// 两者都按数据符号顺序编号, 第 i 个 H 拍配第 i 个数据符号 Y 拍。
//
// 拓扑 (与待建 eq_zf 一致):
//     cp_remove -> fft64_sdf -+-> sb_align -> channel_est_top --> H
//                             |
//                             +-> [Y 路 FIFO, 本 TB 只统计其占用] --> Y
// Y 在 **fft64 输出处直接抽头**, 不经 sb_align —— sb_align 是给 H 路补 frame_start
// 领先一拍用的, Y 路不需要它。
//
// 结论的适用边界: 本 TB **不施加下游背压**, 测的是 Y 不被停时的自然占用。若均衡器
// 自身反压 Y 路, 所需深度只会更大。故本数是**下界**, 选型要在其上留裕量。
//
// 符号边界不能用 o_sb 数: cp_remove 的 o_sb **每帧只在 LTS1 首拍打一拍**(见其第 23 行),
// 不是每符号一拍。符号边界改用 fft64 的 o_idx 回绕到 0 判定。
//
// 判据 (测量 TB 也要有, 否则测错了无从察觉):
//   A  H 输出总拍数 == 数据符号数 x 64          —— 测量对象不得残缺
//   B  峰值占用 > 64                            —— H 至少要等整符号, <=64 说明配对写反
//   C  逐符号因果性: 首个 H 拍晚于该符号末个 Y 拍
//   D  sb_align.o_overflow 全程为 0             —— 否则 Y/H 已错位, 后面的数全不作数
//
// 必须用 xsim (iverilog 编译不了 channel_est_top)。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_y_depth #(
    // sb_align 的容量。默认 4 = 认证包的默认值; 首跑即证明它在**最小帧间距**下
    // 会溢出 (见 README/结论), 故做成可扫的参数而不是写死。
    parameter int P_DEPTH_AL = 4,
    // 帧间空拍。1 = cp_remove 实测的最小间隔 (最恶劣); 真实 802.11a 帧间远大于此。
    parameter int FRAME_GAP  = 1
);

    localparam int DATA_W = 16;
    localparam int N      = 64;
    localparam int N_CP   = 16;
    localparam int NSYM   = 8;                     // 每帧数据符号数
    localparam int LEAD   = 40;                    // fft_start 之前的残留
    localparam int MAXSYM = 64;                    // 记录用上限

    // S5 对抗跑法: 去掉 CP 间隙让符号背靠背。xelab 加 -d NOGAP 切换。
`ifdef NOGAP
    localparam int GAP = 0;
`else
    localparam int GAP = N_CP;
`endif

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    int cyc = 0;
    always_ff @(posedge i_clk) if (!i_rst) cyc <= cyc + 1;

    //--------------------------------------------------------------------------
    // 1) cp_remove
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
    // 2) fft64_sdf — 不可停, i_beat 恒高
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
    // 3) sb_align — 只服务 H 路: 把 fft64 的同拍 o_sb 变成领先一拍的 frame_start
    //--------------------------------------------------------------------------
    logic al_fs, al_tvalid, al_ovf;
    logic [DATA_W*2-1:0] al_tdata;
    logic ce_s_ready;

    sb_align #(.DATA_W(DATA_W), .P_DEPTH(P_DEPTH_AL)) u_align (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(ff_o_valid), .i_re(ff_o_re), .i_im(ff_o_im), .i_sb(ff_o_sb),
        .o_frame_start(al_fs),
        .m_axis_tvalid(al_tvalid), .m_axis_tready(ce_s_ready), .m_axis_tdata(al_tdata),
        .o_overflow(al_ovf));

    //--------------------------------------------------------------------------
    // 4) channel_est_top
    //--------------------------------------------------------------------------
    logic ce_m_valid;
    logic [DATA_W*2-1:0] ce_m_data;

    channel_est_top #(.DATA_W(DATA_W)) u_ce (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_frame_start(al_fs),
        .s_axis_tvalid(al_tvalid), .s_axis_tready(ce_s_ready), .s_axis_tdata(al_tdata),
        .m_axis_tvalid(ce_m_valid), .m_axis_tready(1'b1), .m_axis_tdata(ce_m_data));

    //--------------------------------------------------------------------------
    // 5) Y 侧: 认符号边界, 只数数据符号
    //
    // 帧内符号序: ff_o_sb 标记 LTS1 首个输出拍 -> 序 0; 此后每次 o_idx 回绕到 0
    // 递增。序 0/1 是 LTS (不产 H), 序 >=2 是数据符号。ff_o_sb 之前的一切 (fft64
    // 冷启动残留) 一概不计。
    //--------------------------------------------------------------------------
    bit  seen_frame = 1'b0;          // 是否已见过第一个 ff_o_sb
    int  frame_sym  = 0;             // 帧内符号序
    int  data_sym   = -1;            // 全局数据符号序 (跨帧连续), -1 = 尚未进入数据段

    int  y_cnt = 0;                  // 已产出的数据符号 Y 拍数
    int  h_cnt = 0;                  // 已产出的 H 拍数
    int  peak = 0;

    // 逐符号时刻记录
    int  y_last  [0:MAXSYM-1];       // 该数据符号末个 Y 拍的周期号
    int  h_first [0:MAXSYM-1];       // 该数据符号首个 H 拍的周期号
    int  n_data_sym = 0;             // 实际见到的数据符号数
    bit  ovf_seen = 1'b0;

    // 本拍的符号归属 (组合): 边界拍要用"新"符号序, 否则末尾那拍会记到上一符号头上
    int  w_frame_sym;
    bit  w_boundary, w_is_data;
    int  w_data_sym;

    // 帧内符号序 >= 2+NSYM 的一律不是数据符号 —— 那是 cp_remove 的 **S_FLUSH 冲刷符号**
    // (末数据符号之后的 64 个零拍) 被 fft64 顶出来的产物。帧间距大时它会在下一帧 LTS1
    // 之前独立出现, 若不排除就会被当成第 17 个数据符号, 把 Y/H 配对整体错开一符号。
    // 首跑 FRAME_GAP=400 时正是这样露出来的 (N_DATA_SYM 17, LAT_SYM 8 跳到 270)。
    always_comb begin
        w_boundary  = ff_o_valid && seen_frame && !ff_o_sb && (ff_o_idx == 6'd0);
        w_frame_sym = w_boundary ? (frame_sym + 1) : frame_sym;
        w_is_data   = ff_o_valid && seen_frame && !ff_o_sb
                      && (w_frame_sym >= 2) && (w_frame_sym < 2 + NSYM);
        w_data_sym  = w_boundary ? (data_sym + 1) : data_sym;
    end

    // y_last/h_first 只能有一个驱动源 —— 初值也在这个 always_ff 的复位分支里给,
    // 不能再写一个 initial 去初始化 (那是双驱动, xsim 会照跑但值不可信)。
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            seen_frame <= 1'b0; frame_sym <= 0; data_sym <= -1;
            y_cnt <= 0; h_cnt <= 0; peak <= 0; n_data_sym <= 0; ovf_seen <= 1'b0;
            for (int i = 0; i < MAXSYM; i++) begin
                y_last[i]  <= -1;
                h_first[i] <= -1;
            end
        end else begin
            if (al_ovf) ovf_seen <= 1'b1;

            //---- Y 侧 ----
            if (ff_o_valid && ff_o_sb) begin
                seen_frame <= 1'b1;
                frame_sym  <= 0;                 // 新帧的 LTS1, 不产 H
            end else if (w_boundary) begin
                frame_sym <= w_frame_sym;
                if (w_frame_sym >= 2 && w_frame_sym < 2 + NSYM) begin
                    data_sym   <= w_data_sym;
                    n_data_sym <= n_data_sym + 1;
                end
            end

            if (w_is_data) begin
                y_cnt <= y_cnt + 1;
                if (w_data_sym >= 0 && w_data_sym < MAXSYM) y_last[w_data_sym] <= cyc;
            end

            //---- H 侧 ----
            if (ce_m_valid) begin
                h_cnt <= h_cnt + 1;
                if ((h_cnt % N) == 0 && (h_cnt / N) < MAXSYM) h_first[h_cnt / N] <= cyc;
            end

            //---- 占用峰值。用本拍即将成为的值, 避免寄存一拍漏记峰 ----
            if (((y_cnt + (w_is_data ? 1 : 0)) - (h_cnt + (ce_m_valid ? 1 : 0))) > peak)
                peak <= (y_cnt + (w_is_data ? 1 : 0)) - (h_cnt + (ce_m_valid ? 1 : 0));
        end
    end

    //--------------------------------------------------------------------------
    // 6) channel_est 节流计数 (S2: 如实记录, 不人为施加)
    //--------------------------------------------------------------------------
    int stall_total = 0, stall_run = 0, stall_max = 0;
    always_ff @(posedge i_clk) begin
        if (!i_rst) begin
            if (al_tvalid && !ce_s_ready) begin
                stall_total <= stall_total + 1;
                stall_run   <= stall_run + 1;
                if (stall_run + 1 > stall_max) stall_max <= stall_run + 1;
            end else begin
                stall_run <= 0;
            end
        end
    end

    //--------------------------------------------------------------------------
    // 7) 激励 —— 与 tb_chain_depth 同一套, 便于横向对照
    //--------------------------------------------------------------------------
    task automatic beat(input int idx, input bit fs);
        @(negedge i_clk);
        cp_s_valid = 1'b1; cp_fs = fs;
        cp_s_data  = {DATA_W'(-idx), DATA_W'(idx)};
    endtask

    task automatic push_frame(input int base);
        for (int n = 0; n < 2*N; n++)          beat(base + n, (n == 0));
        for (int k = 0; k < NSYM; k++)
            for (int n = 0; n < GAP + N; n++)  beat(base + 2*N + k*(GAP+N) + n, 1'b0);
    endtask

    int fails = 0;

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        for (int n = 0; n < LEAD; n++) beat(n, 1'b0);       // cp_remove 在 UNSYNC 段静默

        push_frame(LEAD);                                   // 帧 1
        for (int n = 0; n < FRAME_GAP; n++) beat(7000 + n, 1'b0);
        push_frame(20000);                                  // 帧 2 (S3: 跨帧才触发 w_stall_frame)

        // 帧 2 的尾巴仍要冲刷才出得来
        for (int n = 0; n < 6*64; n++) beat(9000 + n, 1'b0);
        @(negedge i_clk); cp_s_valid = 1'b0; cp_fs = 1'b0;
        repeat (900) @(negedge i_clk);

        $display("");
        $display("GAP %0d", GAP);
        $display("P_DEPTH_AL %0d", P_DEPTH_AL);
        $display("FRAME_GAP %0d", FRAME_GAP);
        $display("N_DATA_SYM %0d", n_data_sym);
        $display("Y_BEATS %0d", y_cnt);
        $display("H_BEATS %0d", h_cnt);
        $display("DEPTH_PEAK %0d", peak);
        $display("STALL_TOTAL %0d", stall_total);
        $display("STALL_MAX_RUN %0d", stall_max);
        $display("SB_OVERFLOW %0d", ovf_seen);

        // 逐符号延迟: 该符号末个 Y 拍 -> 该符号首个 H 拍
        begin
            int lat, lmin, lmax;
            lmin = 1 << 30; lmax = -1;
            for (int m = 0; m < n_data_sym && m < MAXSYM; m++) begin
                if (y_last[m] >= 0 && h_first[m] >= 0) begin
                    lat = h_first[m] - y_last[m];
                    if (lat < lmin) lmin = lat;
                    if (lat > lmax) lmax = lat;
                    $display("LAT_SYM %0d %0d", m, lat);
                end
            end
            $display("LAT_MIN %0d", lmin);
            $display("LAT_MAX %0d", lmax);
        end

        $display("");
        $display("--- 判据 ---");
        chk(h_cnt == n_data_sym * N,
            $sformatf("A: H 拍数 %0d == 数据符号数 %0d x 64", h_cnt, n_data_sym));
        chk(peak > N,
            $sformatf("B: 峰值占用 %0d > 64 (H 必须等整符号收齐)", peak));
        begin
            automatic bit causal = 1'b1;
            for (int m = 0; m < n_data_sym && m < MAXSYM; m++)
                if (!(y_last[m] >= 0 && h_first[m] > y_last[m])) causal = 1'b0;
            // 判据文字一律过 $sformatf: xsim 直接打中文字符串字面量会输出乱码,
            // 而 $sformatf 产出的同样文字正常。首跑 C/D 失败时就是因此读不出是哪条挂了。
            chk(causal, $sformatf("C: 逐符号因果性 (首个 H 拍晚于该符号末个 Y 拍)"));
        end
        chk(!ovf_seen, $sformatf("D: sb_align 全程无溢出 (ovf=%0d)", ovf_seen));

        $display("");
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_y_depth (%0d 条判据未过)", fails);
            $fatal(1, "tb_y_depth: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_y_depth (测量 TB, 产出 DEPTH_PEAK)");
        $finish;
    end

endmodule

`default_nettype wire
