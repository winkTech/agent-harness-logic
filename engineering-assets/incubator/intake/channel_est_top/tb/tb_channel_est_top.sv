//==============================================================================
// tb_channel_est_top — channel_est_top 定向自检 TB (ADR-002 架构)
// 验证方案见 var/gates/verification-quality.json (S1-S5):
//   T1  平坦信道 H=1, CPE=0            -> 全 64 点 = 16384 ± tol
//   T2  逐载波变化的复信道 + 注入 CPE (0.3 / -0.2 rad 逐符号) + 数据内容变化
//   T3  m_axis 随机反压重跑 T2 帧      -> 输出逐点一致 (不丢不重)
//   T4  半帧后 i_frame_start 重启      -> 新帧正确, 无旧帧串扰
//   T5  帧中复位 -> 无残留输出, 重新同步后功能正常
//   T6  背靠背 (gap=0) 符号流无死锁; 末拍->输出完成延迟 < 400 拍 (spec §5)
// 判据: 解析期望 (量化 H_fx · e^{jCPE}) ± TOL LSB (CORDIC 14 迭代量化残差);
//       bit-true 逐字对标由 tb_chEst_cosim 承担, 不在本 TB 职责内。
// 失败路径: 一律 $fatal (非零退出), 通过打印 "ALL TESTS PASSED"。
//==============================================================================
`timescale 1ns/1ps

module tb_channel_est_top;

    localparam int N        = 64;
    localparam int TOL      = 12;      // LSB (Q2.14)
    localparam int GAP      = 16;      // 符号间空闲拍 (CP 近似)
    localparam int LAT_MAX  = 400;     // 延迟上限 (1 OFDM 符号 @100MHz)

    // 802.11a LTS 序列 (subcarrier -26..26, DC=0), k = idx+6
    localparam int LTS_SEQ[0:52] = '{
         1, 1,-1,-1, 1, 1,-1, 1,-1, 1, 1, 1, 1, 1, 1,-1,-1, 1, 1,-1, 1,-1, 1, 1, 1, 1,
         0,
         1,-1,-1, 1, 1,-1, 1,-1, 1,-1,-1,-1,-1,-1, 1, 1,-1,-1, 1,-1, 1,-1, 1, 1, 1, 1
    };

    //==========================================================================
    // DUT
    //==========================================================================
    logic        clk = 1'b0;
    logic        rst;
    logic        fs;
    logic        s_tvalid, s_tready;
    logic [31:0] s_tdata;
    logic        m_tvalid, m_tready_r;
    logic [31:0] m_tdata;

    always #5 clk = ~clk;

    channel_est_top #(.DATA_W(16)) dut (
        .i_clk         (clk),
        .i_rst         (rst),
        .i_frame_start (fs),
        .s_axis_tvalid (s_tvalid),
        .s_axis_tready (s_tready),
        .s_axis_tdata  (s_tdata),
        .m_axis_tvalid (m_tvalid),
        .m_axis_tready (m_tready_r),
        .m_axis_tdata  (m_tdata)
    );

    //==========================================================================
    // 周期计数 / 反压 / 输出捕获
    //==========================================================================
    int unsigned cyc = 0;
    always @(posedge clk) cyc <= cyc + 1;

    int bp_mode = 0;   // 0: 常通; 1: 随机反压
    always @(posedge clk) begin
        if (bp_mode == 1) m_tready_r <= ($urandom_range(0, 3) != 0);
        else              m_tready_r <= 1'b1;
    end

    int cap_re[$], cap_im[$];
    int unsigned cap_t[$];

    always @(posedge clk) begin
        if (m_tvalid === 1'b1 && m_tready_r === 1'b1) begin
            cap_re.push_back(int'(signed'(m_tdata[15:0])));
            cap_im.push_back(int'(signed'(m_tdata[31:16])));
            cap_t.push_back(cyc);
        end
    end

    //==========================================================================
    // 工具函数
    //==========================================================================
    function automatic int q14r(input real v);
        real x;
        x = v * 16384.0;
        if (x >= 0.0) q14r = $rtoi(x + 0.5);
        else          q14r = -$rtoi(-x + 0.5);
        if (q14r >  32767) q14r =  32767;
        if (q14r < -32768) q14r = -32768;
    endfunction

    function automatic int lts_sign(input int k);
        if (k < 6 || k > 58) lts_sign = 0;
        else                 lts_sign = LTS_SEQ[k-6];   // 含 DC(k=32)=0
    endfunction

    function automatic int is_pilot(input int k);
        is_pilot = (k == 11 || k == 25 || k == 39 || k == 53);
    endfunction

    function automatic int pilot_val_at(input int k);
        pilot_val_at = (k == 39) ? -1 : 1;              // pilot = [1,1,-1,1]
    endfunction

    //==========================================================================
    // 测试场景数据 (模块级, 各 task 共享)
    //==========================================================================
    real h_re[0:N-1], h_im[0:N-1];     // 真实信道
    int  hfx_re[0:N-1], hfx_im[0:N-1]; // DUT 内量化 H_LTS 期望 (LSB)
    int  sym_i[0:N-1], sym_q[0:N-1];   // 当前待发符号

    // DUT 量化 H_LTS: 无噪且 LTS1=LTS2 时 = q14(H); 保护带/DC = (16384,0)
    task automatic calc_hfx();
        for (int k = 0; k < N; k++) begin
            if (lts_sign(k) == 0) begin
                hfx_re[k] = 16384; hfx_im[k] = 0;
            end else begin
                hfx_re[k] = q14r(h_re[k]);
                hfx_im[k] = q14r(h_im[k]);
            end
        end
    endtask

    task automatic set_channel_flat();
        for (int k = 0; k < N; k++) begin h_re[k] = 1.0; h_im[k] = 0.0; end
        calc_hfx();
    endtask

    task automatic set_channel_varying();
        real amp, ph;
        for (int k = 0; k < N; k++) begin
            amp = 0.25 + real'(k) / 128.0;          // 0.25 .. 0.742
            ph  = 2.0 * 3.14159265358979 * real'(k) * 1.5 / real'(N);
            h_re[k] = amp * $cos(ph);
            h_im[k] = amp * $sin(ph);
        end
        calc_hfx();
    endtask

    task automatic set_channel_const(input real re, input real im);
        for (int k = 0; k < N; k++) begin h_re[k] = re; h_im[k] = im; end
        calc_hfx();
    endtask

    task automatic build_lts();
        int s;
        for (int k = 0; k < N; k++) begin
            s = lts_sign(k);
            sym_i[k] = q14r(h_re[k] * s);
            sym_q[k] = q14r(h_im[k] * s);
        end
    endtask

    // 数据符号: 导频 = H·pv·e^{jphi}; 数据载波 = H·X(seed)·e^{jphi}; 保护带 0
    task automatic build_data(input real phi, input int seed);
        real c, s, xr, xi, yr, yi;
        c = $cos(phi); s = $sin(phi);
        for (int k = 0; k < N; k++) begin
            if (lts_sign(k) == 0 && !is_pilot(k)) begin
                sym_i[k] = 0; sym_q[k] = 0;
            end else begin
                if (is_pilot(k)) begin
                    xr = real'(pilot_val_at(k)); xi = 0.0;
                end else begin
                    xr = (((k + seed) % 2) == 0) ?  0.7 : -0.7;
                    xi = (((k + seed) % 3) == 0) ? -0.7 :  0.7;
                end
                yr = h_re[k]*xr - h_im[k]*xi;
                yi = h_re[k]*xi + h_im[k]*xr;
                sym_i[k] = q14r(yr*c - yi*s);
                sym_q[k] = q14r(yr*s + yi*c);
            end
        end
    endtask

    //==========================================================================
    // 驱动
    //==========================================================================
    task automatic send_beat(input int di, input int dq);
        int unsigned w;
        s_tdata  <= {dq[15:0], di[15:0]};
        s_tvalid <= 1'b1;
        w = 0;
        do begin
            @(posedge clk);
            w++;
            if (w > 5000) $fatal(1, "[%0t] send_beat: s_axis_tready 超时 (死锁?)", $time);
        end while (s_tready !== 1'b1);
    endtask

    task automatic send_symbol(input int gap);
        for (int k = 0; k < N; k++) send_beat(sym_i[k], sym_q[k]);
        s_tvalid <= 1'b0;
        repeat (gap) @(posedge clk);
    endtask

    task automatic pulse_fs();
        @(posedge clk);
        fs <= 1'b1;
        @(posedge clk);
        fs <= 1'b0;
        @(posedge clk);              // 领先首个 LTS 样点 >= 1 拍 (接口契约)
    endtask

    task automatic wait_cap(input int total, input string tag);
        int unsigned w;
        w = 0;
        while (cap_re.size() < total) begin
            @(posedge clk);
            w++;
            if (w > 50000) $fatal(1, "[%s] 等待输出超时: 已捕获 %0d / 需要 %0d",
                                  tag, cap_re.size(), total);
        end
    endtask

    //==========================================================================
    // 判卷: 弹出 64 点, 与 hfx·e^{jphi} 解析期望比对
    //==========================================================================
    task automatic check_sym(input string tag, input real phi);
        real c, s, er, ei;
        int  ge, gi, xe, xi_;
        c = $cos(phi); s = $sin(phi);
        if (cap_re.size() < N) $fatal(1, "[%s] 输出不足: %0d", tag, cap_re.size());
        for (int k = 0; k < N; k++) begin
            er = real'(hfx_re[k])*c - real'(hfx_im[k])*s;
            ei = real'(hfx_re[k])*s + real'(hfx_im[k])*c;
            xe  = (er >= 0.0) ? $rtoi(er + 0.5) : -$rtoi(-er + 0.5);
            xi_ = (ei >= 0.0) ? $rtoi(ei + 0.5) : -$rtoi(-ei + 0.5);
            ge = cap_re.pop_front();
            gi = cap_im.pop_front();
            void'(cap_t.pop_front());
            if ((ge > xe + TOL) || (ge < xe - TOL) ||
                (gi > xi_ + TOL) || (gi < xi_ - TOL)) begin
                $display("[%s] k=%0d 失配: got=(%0d,%0d) exp=(%0d,%0d) tol=%0d",
                         tag, k, ge, gi, xe, xi_, TOL);
                $fatal(1, "[%s] 输出与解析期望不符", tag);
            end
        end
        $display("  [%s] 64/64 子载波在 ±%0d LSB 内 (phi=%f)", tag, TOL, phi);
    endtask

    task automatic expect_idle(input string tag);
        repeat (200) @(posedge clk);
        if (cap_re.size() != 0)
            $fatal(1, "[%s] 存在多余输出: %0d 点", tag, cap_re.size());
    endtask

    //==========================================================================
    // 主流程
    //==========================================================================
    int unsigned t_last, t_done;
    int          base;
    int          t3_re[0:2*N-1], t3_im[0:2*N-1];

    initial begin : p_watchdog
        #8ms;
        $fatal(1, "全局看门狗超时");
    end

    initial begin : p_main
        rst = 1'b1; fs = 1'b0; s_tvalid = 1'b0; s_tdata = '0;
        repeat (5) @(posedge clk);
        rst = 1'b0;
        repeat (3) @(posedge clk);

        //------------------------------------------------------------------
        $display("[T1] 平坦信道 H=1, CPE=0");
        set_channel_flat();
        pulse_fs();
        build_lts();  send_symbol(GAP); send_symbol(GAP);
        build_data(0.0, 0); send_symbol(GAP);
        build_data(0.0, 1); send_symbol(GAP);
        wait_cap(2*N, "T1");
        check_sym("T1 sym0", 0.0);
        check_sym("T1 sym1", 0.0);
        expect_idle("T1");

        //------------------------------------------------------------------
        $display("[T2] 变化复信道 + 逐符号 CPE 跟踪 + 数据内容无关性");
        set_channel_varying();
        pulse_fs();
        build_lts();  send_symbol(GAP); send_symbol(GAP);
        build_data(0.3, 2);  send_symbol(GAP);
        build_data(-0.2, 7); send_symbol(GAP);   // 不同数据内容, 不同 CPE
        wait_cap(2*N, "T2");
        check_sym("T2 sym0 (cpe=+0.3)", 0.3);
        check_sym("T2 sym1 (cpe=-0.2)", -0.2);
        expect_idle("T2");

        //------------------------------------------------------------------
        $display("[T3] m_axis 随机反压重跑 T2 帧 (输出必须逐点一致)");
        // 先无反压跑一遍留基准
        pulse_fs();
        build_lts();  send_symbol(GAP); send_symbol(GAP);
        build_data(0.3, 2);  send_symbol(GAP);
        build_data(-0.2, 7); send_symbol(GAP);
        wait_cap(2*N, "T3-base");
        for (int k = 0; k < 2*N; k++) begin
            t3_re[k] = cap_re.pop_front(); t3_im[k] = cap_im.pop_front();
            void'(cap_t.pop_front());
        end
        bp_mode = 1;
        pulse_fs();
        build_lts();  send_symbol(GAP); send_symbol(GAP);
        build_data(0.3, 2);  send_symbol(GAP);
        build_data(-0.2, 7); send_symbol(GAP);
        wait_cap(2*N, "T3-bp");
        bp_mode = 0;
        for (int k = 0; k < 2*N; k++) begin
            if (cap_re[0] != t3_re[k] || cap_im[0] != t3_im[k])
                $fatal(1, "[T3] 反压下第 %0d 点不一致: got=(%0d,%0d) exp=(%0d,%0d)",
                       k, cap_re[0], cap_im[0], t3_re[k], t3_im[k]);
            void'(cap_re.pop_front()); void'(cap_im.pop_front());
            void'(cap_t.pop_front());
        end
        $display("  [T3] 128/128 点与无反压基准逐点一致");
        expect_idle("T3");

        //------------------------------------------------------------------
        $display("[T4] 半帧后 i_frame_start 重启");
        set_channel_const(0.5, 0.5);
        pulse_fs();
        build_lts();
        send_symbol(0);                          // LTS1 完整
        for (int k = 0; k < 10; k++) send_beat(sym_i[k], sym_q[k]); // LTS2 半途
        s_tvalid <= 1'b0;
        set_channel_const(-0.25, -0.75);
        pulse_fs();                              // 重启
        build_lts();  send_symbol(GAP); send_symbol(GAP);
        build_data(0.1, 3); send_symbol(GAP);
        wait_cap(N, "T4");
        check_sym("T4 sym0 (重启帧)", 0.1);
        expect_idle("T4");

        //------------------------------------------------------------------
        $display("[T5] 帧中复位 -> 重新同步");
        set_channel_flat();
        pulse_fs();
        build_lts();
        for (int k = 0; k < 32; k++) send_beat(sym_i[k], sym_q[k]);
        s_tvalid <= 1'b0;
        @(posedge clk);
        rst <= 1'b1;
        repeat (3) @(posedge clk);
        rst <= 1'b0;
        cap_re.delete(); cap_im.delete(); cap_t.delete();
        // 复位后 UNSYNC: 无 frame_start 时样点应被静默丢弃
        build_data(0.0, 5);
        for (int k = 0; k < 20; k++) send_beat(sym_i[k], sym_q[k]);
        s_tvalid <= 1'b0;
        expect_idle("T5-unsync");
        pulse_fs();
        build_lts();  send_symbol(GAP); send_symbol(GAP);
        build_data(0.0, 0); send_symbol(GAP);
        wait_cap(N, "T5");
        check_sym("T5 sym0 (复位恢复)", 0.0);
        expect_idle("T5");

        //------------------------------------------------------------------
        $display("[T6] 背靠背 (gap=0) + 延迟实测");
        set_channel_varying();
        pulse_fs();
        build_lts();  send_symbol(0); send_symbol(0);
        base = cap_re.size();
        build_data(0.15, 4); send_symbol(0);
        build_data(0.15, 4);                     // 第二符号: 尾拍将撞节流窗口
        for (int k = 0; k < N; k++) send_beat(sym_i[k], sym_q[k]);
        t_last = cyc;
        s_tvalid <= 1'b0;
        wait_cap(base + 2*N, "T6");
        t_done = cap_t[cap_t.size()-1];
        check_sym("T6 sym0", 0.15);
        check_sym("T6 sym1", 0.15);
        if (t_done - t_last >= LAT_MAX)
            $fatal(1, "[T6] 延迟 %0d 拍 >= 上限 %0d", t_done - t_last, LAT_MAX);
        $display("  [T6] 末拍->输出完成 %0d 拍 (< %0d)", t_done - t_last, LAT_MAX);
        expect_idle("T6");

        //------------------------------------------------------------------
        $display("ALL TESTS PASSED");
        $finish;
    end

endmodule : tb_channel_est_top
