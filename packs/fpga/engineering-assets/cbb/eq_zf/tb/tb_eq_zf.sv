//==============================================================================
// tb_eq_zf — 均衡器顶层的位真判据 TB
//
// **写在 eq_zf.sv 之前** (hdl-gate 要求), 因此接口是被判据倒逼定下来的, 不是先写完
// RTL 再补一个迎合它的 TB。
//
// 主判据: 对 vectors/ 下由 rtl_mirror_eq 导出的期望值做 **0 容差**逐点比对
// (2304 点 >= 2048, 对应 D3 判据(1) 与 G-B-03)。镜像与 RTL 走同一条整数路径,
// 任何差异都是缺陷, 没有"量化噪声"这个解释。
//
// 配对语义是**按序**而非按时刻: H 早到晚到都不该改变结果, 只该改变时刻。所以
// T4 故意把 H 从 0 时刻就压上去 (那时 Y 还没进来), 逼 s_axis_h_tready 顶住。
//
// 并发结构用标志位而非 fork/join_none + disable fork —— 后者会让 iverilog 在
// vthread.cc:3790 触发内部断言直接崩掉。同理不用 break/return (iverilog 不支持)。
//
// 打包字序 {im, re} —— 与 cp_remove / channel_est_top 一致。
// 运行 (从 rtl/ 目录):
//   iverilog -g2012 -o tb.out ../tb/tb_eq_zf.sv eq_zf.sv eq_recip.sv && vvp tb.out
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_eq_zf;

    localparam int N     = 64;
    localparam int NLTS  = 2;
    localparam int NSYM  = 48;
    localparam int NDATA = 48;
    localparam int NY    = (NLTS + NSYM) * N;      // 3200
    localparam int NH    = NSYM * N;               // 3072
    localparam int NX    = NSYM * NDATA;           // 2304

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic [31:0] vec_y  [0:NY-1];
    logic [31:0] vec_h  [0:NH-1];
    logic [31:0] vec_x  [0:NX-1];
    logic [31:0] vec_er [0:NX-1];
    logic [31:0] vec_cf [0:NX-1];

    initial begin
        $readmemh("../vectors/y.hex",        vec_y);
        $readmemh("../vectors/h.hex",        vec_h);
        $readmemh("../vectors/x_exp.hex",    vec_x);
        $readmemh("../vectors/er_exp.hex",   vec_er);
        $readmemh("../vectors/conf_exp.hex", vec_cf);
    end

    logic        i_y_valid = 1'b0, i_y_sb = 1'b0;
    logic [15:0] i_y_re = '0, i_y_im = '0;
    logic [5:0]  i_y_idx = '0;

    logic        s_h_tvalid = 1'b0;
    wire         s_h_tready;
    logic [31:0] s_h_tdata = '0;

    wire         m_tvalid;
    logic        m_tready = 1'b1;
    wire  [31:0] m_tdata;
    wire  [11:0] o_conf;
    wire         o_erasure, o_y_overflow;

    // P_YDEPTH 必须是 2 的幂 (指针按 2^YAW 回绕); 256 对实测下界 158 留裕量
    eq_zf #(.P_YDEPTH(256)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_y_valid(i_y_valid), .i_y_re(i_y_re), .i_y_im(i_y_im),
        .i_y_idx(i_y_idx), .i_y_sb(i_y_sb),
        .s_axis_h_tvalid(s_h_tvalid), .s_axis_h_tready(s_h_tready), .s_axis_h_tdata(s_h_tdata),
        .m_axis_tvalid(m_tvalid), .m_axis_tready(m_tready), .m_axis_tdata(m_tdata),
        .o_conf(o_conf), .o_erasure(o_erasure), .o_y_overflow(o_y_overflow));

    //--------------------------------------------------------------------------
    // 记分板
    //--------------------------------------------------------------------------
    int  got_n = 0, fails = 0, mism_x = 0, mism_er = 0, mism_cf = 0;
    bit  ovf_seen = 1'b0;
    // 包络外那一轮本来就该丢点, 逐点打 [X] 会让 PASS 旁边挂一串看着像失败的行 ——
    // 那种日志会训练人忽略告警。该轮静音, 判据只看 o_y_overflow。
    bit  quiet = 1'b0;
    logic [31:0] cap_x [0:NX-1];

    always @(posedge i_clk) begin
        if (!i_rst) begin
            if (o_y_overflow) ovf_seen <= 1'b1;
            if (m_tvalid && m_tready) begin
                if (got_n < NX) begin
                    cap_x[got_n] <= m_tdata;
                    if (m_tdata !== vec_x[got_n]) begin
                        if (mism_x < 5 && !quiet)
                            $display("  [X] #%0d 得 %08X 期望 %08X", got_n, m_tdata, vec_x[got_n]);
                        mism_x <= mism_x + 1;
                    end
                    if (o_erasure !== vec_er[got_n][0]) begin
                        if (mism_er < 5 && !quiet)
                            $display("  [ER] #%0d 得 %b 期望 %b", got_n, o_erasure, vec_er[got_n][0]);
                        mism_er <= mism_er + 1;
                    end
                    // conf 必须与 X **同点**出来: 权重错配不报警, 只让 BER 悄悄变差
                    if (o_conf !== vec_cf[got_n][11:0]) begin
                        if (mism_cf < 5 && !quiet)
                            $display("  [CF] #%0d 得 %03X 期望 %03X", got_n, o_conf, vec_cf[got_n][11:0]);
                        mism_cf <= mism_cf + 1;
                    end
                end
                got_n <= got_n + 1;
            end
        end
    end

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    //--------------------------------------------------------------------------
    // 驱动进程: 用标志位启停, 不用 fork/disable
    //--------------------------------------------------------------------------
    bit go = 1'b0, abort_v = 1'b0, y_busy = 1'b0, h_busy = 1'b0;
    int h_delay_v = 0, rd_mode = 0;

    // 下游 tready: 常驻进程, 按 rd_mode 切换模式
    always @(negedge i_clk) begin
        case (rd_mode)
            1: m_tready <= (($urandom % 4) != 0);          // 随机 75%
            2: m_tready <= ((($time/10) % 200) < 150);     // 周期性长拉低
            3: m_tready <= ~m_tready;                      // 逐拍翻转
            default: m_tready <= 1'b1;
        endcase
    end

    // Y 驱动: 上游 fft64_sdf 结构上不可反压 —— 但它并非逐拍连出。
    // cp_remove 每符号送 80 拍 (CP16 + 64), fft64 每符号只出 64 拍, 故符号间有
    // **16 拍天然空窗**, 即约 20% 余量。逐拍连推是比现实苛刻得多的激励, 会让任何
    // 持续反压都必然把 Y 路 FIFO 撑爆 —— 那测的就不是 DUT 而是激励本身了。
    localparam int Y_GAP = 16;

    initial forever begin
        @(posedge go);
        y_busy = 1'b1;
        for (int n = 0; n < NY; n++) begin
            @(negedge i_clk);
            i_y_valid = 1'b1;
            i_y_sb    = (n == 0);
            i_y_idx   = 6'(n % N);
            i_y_re    = vec_y[n][15:0];
            i_y_im    = vec_y[n][31:16];
            if ((n % N) == (N-1)) begin                 // 符号末拍后插空窗
                @(negedge i_clk);
                i_y_valid = 1'b0; i_y_sb = 1'b0;
                repeat (Y_GAP - 1) @(negedge i_clk);
            end
        end
        @(negedge i_clk);
        i_y_valid = 1'b0; i_y_sb = 1'b0;
        y_busy = 1'b0;
    end

    // H 驱动: 受 tready 节流; 只有被接受才推进 (不用 break)
    initial forever begin
        int n;
        @(posedge go);
        h_busy = 1'b1;
        repeat (h_delay_v) @(negedge i_clk);
        n = 0;
        while (n < NH && !abort_v) begin
            @(negedge i_clk);
            s_h_tvalid = 1'b1;
            s_h_tdata  = vec_h[n];
            if (s_h_tready) n = n + 1;
        end
        @(negedge i_clk);
        s_h_tvalid = 1'b0;
        h_busy = 1'b0;
    end

    //--------------------------------------------------------------------------
    task automatic run_round(input int h_delay, input int md);
        int guard;
        i_rst    = 1'b1;
        abort_v  = 1'b0;
        rd_mode  = 0;
        repeat (5) @(negedge i_clk);
        got_n = 0; mism_x = 0; mism_er = 0; mism_cf = 0; ovf_seen = 1'b0;
        h_delay_v = h_delay;
        i_rst = 1'b0;
        @(negedge i_clk);
        rd_mode = md;
        go = 1'b1; @(negedge i_clk); go = 1'b0;
        guard = 0;
        while (got_n < NX && guard < 400000) begin
            @(posedge i_clk); guard++;
        end
        repeat (200) @(posedge i_clk);
        abort_v = 1'b1;
        wait (!y_busy && !h_busy);
        rd_mode = 0;
        repeat (5) @(negedge i_clk);
    endtask

    logic [31:0] ref_x [0:NX-1];
    bit          same;                     // iverilog 不支持块内 automatic 声明

    initial begin
        //================= 轮 1: 无反压, H 滞后 (贴近真实链路) =============
        run_round(80, 0);
        chk(got_n == NX, $sformatf("T1 输出点数 %0d (期望 %0d, LTS 不得产出)", got_n, NX));
        chk(mism_x  == 0, $sformatf("T2 **0 容差位真**: X 失配 %0d 点", mism_x));
        chk(mism_er == 0, $sformatf("T3 erasure 失配 %0d 点", mism_er));
        chk(mism_cf == 0, $sformatf("T3b o_conf 失配 %0d 点 (逐载波可靠度须与 X 同点)", mism_cf));
        chk(!ovf_seen,    "T5 Y 路 FIFO 未溢出 (深度 256 对实测下界 158)");
        for (int k = 0; k < NX; k++) ref_x[k] = cap_x[k];

        //================= 轮 2: H 从 0 时刻压上 (逼 tready) ===============
        run_round(0, 0);
        chk(got_n == NX && mism_x == 0 && mism_er == 0,
            $sformatf("T4 H 不滞后也一致 (点数 %0d, 失配 %0d/%0d) —— 配对按序不按时刻",
                      got_n, mism_x, mism_er));

        //================= 轮 3-4: 包络内的下游反压 ========================
        // Y 的平均占空是 64/80 = **80%** (符号间有 16 拍 CP 空窗), 这就是下游必须
        // 跟得上的速率。模式 1 (随机 75% 高) 与模式 2 (200 拍里低 50) 的平均接受率
        // 都在 80% 以上, 属包络内 —— 反压只许改变时刻, 不许改变数值。
        for (int md = 1; md <= 2; md++) begin
            same = 1'b1;
            run_round(80, md);
            if (got_n != NX || mism_x != 0 || mism_er != 0) same = 1'b0;
            for (int k = 0; k < NX; k++) if (cap_x[k] !== ref_x[k]) same = 1'b0;
            // 溢出必须逐轮查: 反压期间 Y 停不下来, 一旦 FIFO 撑爆就会静默丢点,
            // 表现为"数值错乱 + 点数变少", 很容易被误诊成流水线错位。
            if (ovf_seen) same = 1'b0;
            chk(same, $sformatf("T6 反压模式 %0d (包络内): 与基准逐点相同 (点数 %0d, 失配 %0d, 溢出 %0d)",
                                md, got_n, mism_x, ovf_seen));
        end

        //================= 轮 5: 包络**外**的反压 —— 判"不得静默" ==========
        // 逐拍翻转 = 下游只收 50%, 低于 Y 的 80% 占空。这是本模块结构上兜不住的工况:
        // 上游 fft64_sdf 停不下来, Y 只能堆积直到 FIFO 满。加深 FIFO 也只是推迟,
        // 不能解决 —— 平均速率不够就是不够。
        // 因此这里**不要求数值正确**, 要求的是**不许静默**: 必须拉起 o_y_overflow。
        // 悄悄丢点而不报, 才是真正危险的失效模式。
        quiet = 1'b1;
        run_round(80, 3);
        quiet = 1'b0;
        chk(ovf_seen, $sformatf("T6b 包络外反压 (下游 50%% < Y 的 80%%): 必须拉起 o_y_overflow 而非静默丢点 (溢出 %0d, 收到 %0d/%0d)",
                                ovf_seen, got_n, NX));

        //================= 轮 6: 帧中途复位, 再整帧重入 ====================
        i_rst = 1'b1; abort_v = 1'b0; rd_mode = 0;
        repeat (5) @(negedge i_clk);
        got_n = 0; mism_x = 0; mism_er = 0;
        h_delay_v = 80;
        i_rst = 1'b0;
        @(negedge i_clk);
        go = 1'b1; @(negedge i_clk); go = 1'b0;
        repeat (900) @(posedge i_clk);
        i_rst = 1'b1;                                       // 帧中途复位
        repeat (10) @(posedge i_clk);
        chk(m_tvalid === 1'b0, "T7a 复位期间 m_axis_tvalid 为 0");
        abort_v = 1'b1;
        wait (!y_busy && !h_busy);
        repeat (5) @(negedge i_clk);

        run_round(80, 0);
        chk(got_n == NX && mism_x == 0 && mism_er == 0,
            $sformatf("T7b 复位后重入整帧逐点正确 (点数 %0d, 失配 %0d)", got_n, mism_x));

        $display("");
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_eq_zf (%0d 条未过)", fails);
            $fatal(1, "tb_eq_zf: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_eq_zf (2304 点 0 容差)");
        $finish;
    end

endmodule

`default_nettype wire
