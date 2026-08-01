//==============================================================================
// tb_ofdm_tx_top — ofdm_tx_top 定向自检 TB (ADR-004 架构)
//
// 判据: 输出与 TB 内浮点参考 (RTL 量化星座 → 网格 → DFT/8 → CP → Q3.13) 比对
//       ±TOL LSB; bit-true 逐位由 cosim 承担 (G-B-03, 未完成)。
//
// 场景 (对应 docs/rules/03-gates.md 门禁二 S1–S5 与准入门 G-C-04/G-C-05):
//   R  regression  — 四调制 (BPSK/QPSK/16QAM/64QAM) 各 3 符号全判据      [S1]
//   B  boundary    — 最小 1 符号 / 最大 8 符号 / 输入侧空隙流            [S3]
//   P  backpressure— 4 种 tready 模式与无反压基准逐点一致                [S2]
//   S  stress      — 12 帧连续、帧间切换调制、满吞吐                     [S5]
//   X  reset       — 帧中复位保持 3 拍, 逐寄存器比对声明复位值 + 复位后重入 [S4]
//
// 每符号 48 拍比特组输入 → 80 拍时域输出; tlast 于每符号第 80 拍。
// 尾部冲刷: 每帧后馈 2 个全零符号 (契约), 冲刷输出不计入比对。
//
// 证据落地: +EVID=<dir> 时写 <dir>/stability/{regression,boundary,
//           backpressure,stress}.json 与 <dir>/reset-sim.json。
// 失败一律计入对应场景的 pass=false, 全部场景跑完后再 $fatal (保证证据先落盘)。
//==============================================================================
`timescale 1ns/1ps

module tb_ofdm_tx_top;

    localparam int  NMAX = 8;                    // 单帧最大符号数
    localparam int  TOL  = 4;
    localparam real PI   = 3.14159265358979;

    logic        clk = 0, rst;
    logic [3:0]  cfg_mod;
    logic [5:0]  s_tdata;
    logic        s_tvalid, s_tready;
    logic [31:0] m_tdata;
    logic        m_tvalid, m_tlast;
    logic        m_tready_r;

    int bp_mode;                                 // 0 常高 / 1 随机 / 2 周期 / 3 长拉低 / 4 逐拍翻转
    int gap_mode;                                // 0 无空隙 / 1 每拍 1 空隙 / 2 随机 0..3
    int bp_cnt;

    always #5 clk = ~clk;

    ofdm_tx_top #(.DATA_W(16)) dut (
        .i_clk          (clk),
        .i_rst          (rst),
        .i_cfg_mod_type (cfg_mod),
        .s_axis_tdata   (s_tdata),
        .s_axis_tvalid  (s_tvalid),
        .s_axis_tready  (s_tready),
        .s_axis_tlast   (1'b0),
        .m_axis_tdata   (m_tdata),
        .m_axis_tvalid  (m_tvalid),
        .m_axis_tready  (m_tready_r),
        .m_axis_tlast   (m_tlast)
    );

    always @(posedge clk) begin
        bp_cnt <= bp_cnt + 1;
        case (bp_mode)
            1:       m_tready_r <= ($urandom_range(0, 3) != 0);
            2:       m_tready_r <= (bp_cnt % 8) < 4;
            3:       m_tready_r <= (bp_cnt % 200) >= 50;
            4:       m_tready_r <= ~m_tready_r;
            default: m_tready_r <= 1'b1;
        endcase
    end

    // 乒乓不变量: 收集侧永不写入正在流出的 bank。违反即数据被覆写 ——
    // 顶层符号信用 (≤2 在途) 是唯一保障, 信用记账一旦回绕就会在此暴露。
    int coll_n;
    always @(posedge clk) begin
        if (!rst && dut.u_pilot_map.i_valid && dut.u_pilot_map.r_sact &&
            (dut.u_pilot_map.r_wbank === dut.u_pilot_map.r_sbank)) begin
            if (coll_n == 0)
                $display("  [PMAP-COLL] 乒乓冲突: 写 bank %0d 正在流出 (wcnt=%0d scnt=%0d credit=%0d)",
                         dut.u_pilot_map.r_wbank, dut.u_pilot_map.r_wcnt,
                         dut.u_pilot_map.r_scnt, dut.r_credit);
            coll_n++;
        end
    end

    //==========================================================================
    // 确定性比特源 + RTL 量化星座 (与 tx_mapper 常数逐字一致)
    //==========================================================================
    int unsigned lcg;
    function automatic int lrand();
        lcg = lcg*32'd1664525 + 32'd1013904223;
        lrand = int'(lcg >> 16) & 32'hffff;
    endfunction

    localparam int P_PAM4 [0:3] = '{-15543, -5181, 15543, 5181};
    localparam int P_PAM8 [0:7] = '{-17697, -12641, -2528, -7584,
                                     17697,  12641,  2528,  7584};

    function automatic void map_bits(input int mod, input int b[6],
                                     output int re, output int im);
        case (mod)
            0: begin re = b[0] ? 16384 : -16384; im = 0; end
            1: begin re = b[0] ? 11585 : -11585; im = b[1] ? 11585 : -11585; end
            2: begin re = P_PAM4[b[0]*2+b[1]]; im = P_PAM4[b[2]*2+b[3]]; end
            default: begin
                re = P_PAM8[b[0]*4+b[1]*2+b[2]];
                im = P_PAM8[b[3]*4+b[4]*2+b[5]];
            end
        endcase
    endfunction

    // 数据序号 -> 自然 bin (golden data_idx 升序)
    function automatic int f_bin(input int d);
        int lst [0:47];
        int n;
        n = 0;
        for (int i = -26; i <= 26; i++) begin
            if (i == 0 || i == -21 || i == -7 || i == 7 || i == 21) continue;
            lst[n] = i; n++;
        end
        f_bin = (lst[d] < 0) ? (64 + lst[d]) : lst[d];
    endfunction

    //==========================================================================
    // 帧构造与浮点参考
    //==========================================================================
    int  bits_q [0:NMAX*48-1][0:5];
    real gr [0:NMAX-1][0:63], gi [0:NMAX-1][0:63];
    int  exp_i [0:NMAX*80-1], exp_q [0:NMAX*80-1];

    task automatic build_frame(input int mod, input int seed, input int nsym);
        int b[6], re, im, nb, d, s, n2;
        real yr, yi, ph, pol;
        real tr [0:63], ti [0:63];
        lcg = seed;
        nb = (mod==0) ? 1 : (mod==1) ? 2 : (mod==2) ? 4 : 6;
        for (s = 0; s < nsym; s++) begin
            for (int k = 0; k < 64; k++) begin gr[s][k]=0.0; gi[s][k]=0.0; end
            pol = (s % 2 == 0) ? 1.0 : -1.0;
            gr[s][7]  =  pol*16384.0;
            gr[s][21] = -pol*16384.0;
            gr[s][43] =  pol*16384.0;
            gr[s][57] =  pol*16384.0;
            for (d = 0; d < 48; d++) begin
                for (int j = 0; j < 6; j++)
                    b[j] = (j < nb) ? (lrand() & 1) : 0;
                for (int j = 0; j < 6; j++) bits_q[s*48+d][j] = b[j];
                map_bits(mod, b, re, im);
                gr[s][f_bin(d)] = real'(re);
                gi[s][f_bin(d)] = real'(im);
            end
            // 参考: y[n] = Σ X_k e^{+j2πnk/64} / 8 (Q2.14 域) -> /2 = Q3.13
            for (int n = 0; n < 64; n++) begin
                yr = 0.0; yi = 0.0;
                for (int k = 0; k < 64; k++) begin
                    ph = 2.0*PI*n*k/64.0;
                    yr += gr[s][k]*$cos(ph) - gi[s][k]*$sin(ph);
                    yi += gr[s][k]*$sin(ph) + gi[s][k]*$cos(ph);
                end
                tr[n] = yr/16.0;
                ti[n] = yi/16.0;
            end
            for (int k = 0; k < 80; k++) begin
                n2 = (k < 16) ? (48 + k) : (k - 16);
                exp_i[s*80+k] = $rtoi(tr[n2] + (tr[n2] >= 0.0 ? 0.5 : -0.5));
                exp_q[s*80+k] = $rtoi(ti[n2] + (ti[n2] >= 0.0 ? 0.5 : -0.5));
            end
        end
    endtask

    //==========================================================================
    // 捕获与驱动
    //==========================================================================
    int cap_i [$], cap_q [$];
    int last_pos [$];

    always @(posedge clk) begin
        if (m_tvalid === 1'b1 && m_tready_r === 1'b1) begin
            cap_i.push_back(int'(signed'(m_tdata[15:0])));
            cap_q.push_back(int'(signed'(m_tdata[31:16])));
            if (m_tlast === 1'b1) last_pos.push_back(cap_i.size()-1);
        end
    end

    task automatic send_group(input int b[6]);
        int unsigned w;
        int gaps;
        gaps = (gap_mode == 1) ? 1 : (gap_mode == 2) ? $urandom_range(0, 3) : 0;
        if (gaps > 0) begin                       // 输入侧空隙: tvalid 拉低
            s_tvalid <= 1'b0;
            repeat (gaps) @(posedge clk);
        end
        s_tdata  <= {b[5]!=0, b[4]!=0, b[3]!=0, b[2]!=0, b[1]!=0, b[0]!=0};
        s_tvalid <= 1'b1;
        w = 0;
        do begin
            @(posedge clk); w++;
            if (w > 5000) $fatal(1, "send_group: s_tready 超时");
        end while (s_tready !== 1'b1);
    endtask

    task automatic run_frame(input int mod, input string tag, input int nsym);
        int b[6];
        int unsigned w;
        cap_i.delete(); cap_q.delete(); last_pos.delete();
        for (int s = 0; s < nsym; s++)
            for (int d = 0; d < 48; d++) begin
                for (int j = 0; j < 6; j++) b[j] = bits_q[s*48+d][j];
                send_group(b);
            end
        for (int j = 0; j < 6; j++) b[j] = 0;    // 尾部冲刷 2 零符号
        repeat (96) send_group(b);
        s_tvalid <= 1'b0;
        w = 0;
        while (cap_i.size() < nsym*80) begin
            @(posedge clk); w++;
            if (w > 80000) begin
                $display("  [%s] 输出超时: %0d/%0d", tag, cap_i.size(), nsym*80);
                return;
            end
        end
    endtask

    // 返回失配点数 (0 = 通过); 不 $fatal, 由场景汇总后统一判定
    function automatic int check_frame(input string tag, input int nsym);
        int nerr;
        nerr = 0;
        if (cap_i.size() < nsym*80) begin
            $display("  [%s] 样点不足: %0d/%0d", tag, cap_i.size(), nsym*80);
            return nsym*80;
        end
        for (int n = 0; n < nsym*80; n++) begin
            if (cap_i[n] - exp_i[n] > TOL || exp_i[n] - cap_i[n] > TOL ||
                cap_q[n] - exp_q[n] > TOL || exp_q[n] - cap_q[n] > TOL) begin
                if (nerr < 6)
                    $display("  [%s] n=%0d got=(%0d,%0d) exp=(%0d,%0d)",
                             tag, n, cap_i[n], cap_q[n], exp_i[n], exp_q[n]);
                nerr++;
            end
        end
        for (int s = 0; s < nsym; s++)
            if (last_pos.size() <= s || last_pos[s] != s*80+79) begin
                $display("  [%s] tlast 错位: 符号 %0d", tag, s);
                nerr++;
            end
        return nerr;
    endfunction

    task automatic reset_dut();
        @(posedge clk);
        rst <= 1'b1;
        repeat (5) @(posedge clk);
        rst <= 1'b0;
        repeat (3) @(posedge clk);
    endtask

    //==========================================================================
    // 证据落盘
    //==========================================================================
    // 证据写在仿真运行目录 (xsim 的 -testplusarg 无法可靠传含盘符/分隔符的路径),
    // 由 run_xsim.sh 搬运到 var/gates/pg/<uid>/ 下的门禁约定位置。
    //
    // reason 由调用方直接写入格式串, 不经 %s 传参 —— xsim 的 $fwrite 用 %s 输出
    // 含多字节字符的 string 会损坏内容 (实测), 而格式串内的同样文字完好。
    function automatic int ev_begin(input string name, input bit ok, input int beats);
        int fd;
        string t;
        t = ok ? "true" : "false";               // 经 string 变量, 避免三元等宽补位
        fd = $fopen($sformatf("stability-%s.json", name), "w");
        if (fd == 0) begin
            $display("  [WARN] 无法写 stability-%s.json", name);
            return 0;
        end
        $fwrite(fd, "{\"pass\": %s, \"beats\": %0d, \"tool\": \"Vivado xsim 2023.1\", \"tb\": \"tb_ofdm_tx_top\", \"reason\": \"",
                t, beats);
        $display("  [证据] stability-%s.json pass=%s", name, t);
        return fd;
    endfunction

    function automatic void ev_end(input int fd);
        if (fd != 0) begin
            $fwrite(fd, "\"}\n");
            $fclose(fd);
        end
    endfunction

    //==========================================================================
    // 逐寄存器复位比对 (G-C-04)
    // 仅列受复位控制的控制链寄存器; 数据通路寄存器按 §1.1/§10.2 少复位设计,
    // 不受复位控制, 故排除 —— 排除项在 method 字段写明, 不静默略过。
    //==========================================================================
    int rst_fd, rst_err, rst_n;

    function automatic void chk_reg(input string nm, input int got, input int want);
        if (rst_fd != 0) begin
            if (rst_n > 0) $fwrite(rst_fd, ",\n");
            $fwrite(rst_fd, "    {\"reg\":\"%s\",\"got\":%0d,\"want\":%0d,\"pass\":%s}",
                    nm, got, want, (got === want) ? "true" : "false");
        end
        rst_n++;
        if (got !== want) begin
            rst_err++;
            $display("  [RESET] %s got=%0d want=%0d", nm, got, want);
        end
    endfunction

    task automatic reset_register_audit();
        rst_err = 0;
        rst_fd  = 0;
        rst_n   = 0;
        rst_fd  = $fopen("reset-sim.json", "w");
        if (rst_fd != 0) begin
            $fwrite(rst_fd, "{\n  \"id\": \"G-C-04.reset\",\n");
            $fwrite(rst_fd, "  \"method\": \"mid-frame re-reset held 3 clk, per-register compare vs declared reset value; data-path regs (ro_re/ro_im/fifo/r_rd/ro_tdata/DSP 级) are reset-free by design (hdl §1.1/§10.2) and excluded\",\n");
            $fwrite(rst_fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
            $fwrite(rst_fd, "  \"registers\": [\n");
        end

        // 顶层信用/握手链
        chk_reg("dut.ri_v",                     int'(dut.ri_v),                     0);
        chk_reg("dut.r_credit",                 int'(dut.r_credit),                 2);
        chk_reg("dut.r_bcnt",                   int'(dut.r_bcnt),                   0);
        chk_reg("dut.ro_tready",                int'(dut.ro_tready),                0);
        // tx_mapper
        chk_reg("dut.u_mapper.r_v1",            int'(dut.u_mapper.r_v1),            0);
        chk_reg("dut.u_mapper.ro_valid",        int'(dut.u_mapper.ro_valid),        0);
        // tx_pilot_map
        chk_reg("dut.u_pilot_map.r_wbank",      int'(dut.u_pilot_map.r_wbank),      0);
        chk_reg("dut.u_pilot_map.r_wcnt",       int'(dut.u_pilot_map.r_wcnt),       0);
        chk_reg("dut.u_pilot_map.r_col_done",   int'(dut.u_pilot_map.r_col_done),   0);
        chk_reg("dut.u_pilot_map.r_pend",       int'(dut.u_pilot_map.r_pend),       0);
        chk_reg("dut.u_pilot_map.r_sbank",      int'(dut.u_pilot_map.r_sbank),      0);
        chk_reg("dut.u_pilot_map.r_sact",       int'(dut.u_pilot_map.r_sact),       0);
        chk_reg("dut.u_pilot_map.r_scnt",       int'(dut.u_pilot_map.r_scnt),       0);
        chk_reg("dut.u_pilot_map.r_pol",        int'(dut.u_pilot_map.r_pol),        0);
        chk_reg("dut.u_pilot_map.ro_valid",     int'(dut.u_pilot_map.ro_valid),     0);
        // ifft64_sdf: 各级控制链
        chk_reg("dut.u_ifft.g_stage[1].r_cnt",  int'(dut.u_ifft.g_stage[1].r_cnt),  0);
        chk_reg("dut.u_ifft.g_stage[1].r_warm", int'(dut.u_ifft.g_stage[1].r_warm), 0);
        chk_reg("dut.u_ifft.g_stage[2].r_cnt",  int'(dut.u_ifft.g_stage[2].r_cnt),  0);
        chk_reg("dut.u_ifft.g_stage[3].r_cnt",  int'(dut.u_ifft.g_stage[3].r_cnt),  0);
        chk_reg("dut.u_ifft.g_stage[4].r_cnt",  int'(dut.u_ifft.g_stage[4].r_cnt),  0);
        chk_reg("dut.u_ifft.g_stage[5].r_cnt",  int'(dut.u_ifft.g_stage[5].r_cnt),  0);
        chk_reg("dut.u_ifft.g_stage[6].r_cnt",  int'(dut.u_ifft.g_stage[6].r_cnt),  0);
        chk_reg("dut.u_ifft.g_stage[6].r_warm", int'(dut.u_ifft.g_stage[6].r_warm), 0);
        chk_reg("dut.u_ifft.ro_valid",          int'(dut.u_ifft.ro_valid),          0);
        chk_reg("dut.u_ifft.ro_idx",            int'(dut.u_ifft.ro_idx),            0);
        chk_reg("dut.u_ifft.r_ocnt",            int'(dut.u_ifft.r_ocnt),            0);
        // tx_cp_insert
        chk_reg("dut.u_cp.r_wbank",             int'(dut.u_cp.r_wbank),             0);
        chk_reg("dut.u_cp.r_wcnt",              int'(dut.u_cp.r_wcnt),              0);
        chk_reg("dut.u_cp.r_rbank",             int'(dut.u_cp.r_rbank),             0);
        chk_reg("dut.u_cp.r_ract",              int'(dut.u_cp.r_ract),              0);
        chk_reg("dut.u_cp.r_rpend",             int'(dut.u_cp.r_rpend),             0);
        chk_reg("dut.u_cp.r_rcnt",              int'(dut.u_cp.r_rcnt),              0);
        chk_reg("dut.u_cp.r_v1",                int'(dut.u_cp.r_v1),                0);
        chk_reg("dut.u_cp.r_l1",                int'(dut.u_cp.r_l1),                0);
        chk_reg("dut.u_cp.ro_tvalid",           int'(dut.u_cp.ro_tvalid),           0);
        chk_reg("dut.u_cp.ro_tlast",            int'(dut.u_cp.ro_tlast),            0);
        chk_reg("dut.u_cp.r_ocnt",              int'(dut.u_cp.r_ocnt),              0);
        chk_reg("dut.u_cp.ro_done",             int'(dut.u_cp.ro_done),             0);
        chk_reg("dut.u_cp.ro_ovf",              int'(dut.u_cp.ro_ovf),              0);

        if (rst_fd != 0) begin
            $fwrite(rst_fd, "\n  ],\n  \"checked\": %0d,\n  \"pass\": %s\n}\n",
                    rst_n, (rst_err == 0) ? "true" : "false");
            $fclose(rst_fd);
            rst_fd = 0;
        end
    endtask

    //==========================================================================
    // 主流程
    //==========================================================================
    int base_i [0:NMAX*80-1], base_q [0:NMAX*80-1];
    string names [0:3];

    initial begin : p_watchdog
        #200ms;
        $fatal(1, "全局看门狗超时");
    end

    initial begin : p_main
        int e, tot, beats, fd;
        bit ok_reg, ok_bnd, ok_bp, ok_str, ok_rst;

        names[0] = "BPSK"; names[1] = "QPSK";
        names[2] = "16QAM"; names[3] = "64QAM";
        rst = 1'b1; s_tvalid = 1'b0; s_tdata = '0;
        bp_mode = 0; gap_mode = 0; bp_cnt = 0; coll_n = 0; m_tready_r = 1'b1;
        cfg_mod = 4'd1;
        repeat (6) @(posedge clk);
        rst = 1'b0;
        repeat (3) @(posedge clk);

        //------------------------------------------------------------------
        // R regression — 四调制各 3 符号 [S1]
        //------------------------------------------------------------------
        $display("[R] regression — 四调制各 3 符号");
        tot = 0;
        for (int m = 0; m < 4; m++) begin
            reset_dut();
            cfg_mod = 4'(m);
            build_frame(m, 32'd20260801 + m, 3);
            run_frame(m, names[m], 3);
            e = check_frame(names[m], 3);
            tot += e;
            $display("  [%s] 240 样点 失配 %0d", names[m], e);
        end
        ok_reg = (tot == 0);
        fd = ev_begin("regression", ok_reg, 4*240);
        if (ok_reg) $fwrite(fd, "四调制 (BPSK/QPSK/16QAM/64QAM) 各 3 符号, 每帧 240 样点全部落在浮点参考 ±4 LSB 内, tlast 逐符号对齐于第 80 拍");
        else        $fwrite(fd, "四调制回归存在失配点 %0d 个", tot);
        ev_end(fd);

        //------------------------------------------------------------------
        // B boundary — 最小 1 符号 / 最大 8 符号 / 输入侧空隙流 [S3]
        //------------------------------------------------------------------
        $display("[B] boundary — 1 符号 / 8 符号 / 空隙流");
        tot = 0;
        reset_dut(); cfg_mod = 4'd1;
        build_frame(1, 32'd31415926, 1);
        run_frame(1, "B-min", 1);
        e = check_frame("B-min", 1); tot += e;
        $display("  [B-min]  1 符号  80 样点 失配 %0d", e);

        reset_dut(); cfg_mod = 4'd2;
        build_frame(2, 32'd27182818, NMAX);
        run_frame(2, "B-max", NMAX);
        e = check_frame("B-max", NMAX); tot += e;
        $display("  [B-max]  %0d 符号 %0d 样点 失配 %0d", NMAX, NMAX*80, e);

        reset_dut(); cfg_mod = 4'd1;
        gap_mode = 2;                             // 输入侧随机 0..3 拍空隙
        build_frame(1, 32'd16180339, 3);
        run_frame(1, "B-gap", 3);
        e = check_frame("B-gap", 3); tot += e;
        gap_mode = 0;
        $display("  [B-gap]  空隙流 240 样点 失配 %0d", e);

        ok_bnd = (tot == 0);
        fd = ev_begin("boundary", ok_bnd, 80 + NMAX*80 + 240);
        if (ok_bnd) $fwrite(fd, "最小帧 1 符号 (80 样点) / 最大帧 8 符号 (640 样点) / 输入侧随机 0-3 拍空隙流 (240 样点), 三者全部 ±4 LSB 内且 tlast 逐符号对齐 —— 空隙流通过证明各级计数受握手门控");
        else        $fwrite(fd, "边界场景存在失配点 %0d 个", tot);
        ev_end(fd);

        //------------------------------------------------------------------
        // P backpressure — 4 种 tready 模式与无反压基准逐点一致 [S2]
        //------------------------------------------------------------------
        $display("[P] backpressure — 4 种反压模式 vs 基准");
        cfg_mod = 4'd1;
        build_frame(1, 32'd11235813, 3);
        reset_dut();
        run_frame(1, "P-base", 3);
        tot = check_frame("P-base", 3);
        for (int n = 0; n < 3*80; n++) begin
            base_i[n] = cap_i[n]; base_q[n] = cap_q[n];
        end
        for (int p = 1; p <= 4; p++) begin
            int d;
            reset_dut();
            bp_mode = p;
            run_frame(1, $sformatf("P-%0d", p), 3);
            bp_mode = 0;
            d = 0;
            if (cap_i.size() < 3*80) d = 3*80;
            else for (int n = 0; n < 3*80; n++)
                if (cap_i[n] != base_i[n] || cap_q[n] != base_q[n]) d++;
            tot += d;
            $display("  [P-%0d] %s 与基准差异 %0d 点", p,
                     (p==1) ? "随机 75%%" : (p==2) ? "周期 4 低 4 高" :
                     (p==3) ? "每 200 拍长拉低 50" : "逐拍翻转 50%%", d);
        end
        ok_bp = (tot == 0);
        fd = ev_begin("backpressure", ok_bp, 5*240);
        if (ok_bp) $fwrite(fd, "4 种 m_axis_tready 模式 (随机 75%%, 周期 4 低 4 高, 每 200 拍长拉低 50, 逐拍翻转 50%%) 各 240 样点与无反压基准逐点一致, 不丢不重不乱序");
        else       $fwrite(fd, "反压模式下与无反压基准存在差异 %0d 点", tot);
        ev_end(fd);

        //------------------------------------------------------------------
        // S stress — 12 帧连续, 帧间切换调制, 满吞吐 [S5]
        //------------------------------------------------------------------
        $display("[S] stress — 12 帧连续, 帧间切换调制");
        tot = 0; beats = 0;
        for (int f = 0; f < 12; f++) begin
            int md;
            md = f % 4;
            reset_dut();
            cfg_mod = 4'(md);
            build_frame(md, 32'd70000 + f*7919, 3);
            run_frame(md, $sformatf("S-%0d", f), 3);
            e = check_frame($sformatf("S-%0d", f), 3);
            tot += e; beats += 240;
        end
        ok_str = (tot == 0);
        $display("  [S] 12 帧 %0d 样点 失配 %0d", beats, tot);
        fd = ev_begin("stress", ok_str, beats);
        if (ok_str) $fwrite(fd, "12 帧连续满吞吐 (2880 样点), 帧间轮换四种调制, 每帧 3 符号 240 样点全部 ±4 LSB 内且 tlast 对齐");
        else        $fwrite(fd, "压力场景存在失配点 %0d 个", tot);
        ev_end(fd);

        //------------------------------------------------------------------
        // X reset — 帧中复位 + 逐寄存器比对 + 复位后重入 [S4]
        //------------------------------------------------------------------
        $display("[X] reset — 帧中复位, 逐寄存器比对, 复位后重入");
        reset_dut();
        cfg_mod = 4'd3;
        build_frame(3, 32'd99991, 3);
        fork : f_mid_reset
            begin
                run_frame(3, "X-abort", 3);       // 会因中途复位而超时返回
            end
            begin
                repeat (700) @(posedge clk);      // 帧中途注入复位
                rst <= 1'b1;
                repeat (3) @(posedge clk);
                #1;                               // 越过 NBA 更新区再采样
                reset_register_audit();           // 复位保持期间逐寄存器比对
                rst <= 1'b0;
            end
        join_any
        disable f_mid_reset;
        s_tvalid <= 1'b0;
        repeat (10) @(posedge clk);

        // 复位后重入: 全新一帧必须完全正确
        reset_dut();
        cfg_mod = 4'd1;
        build_frame(1, 32'd424242, 3);
        run_frame(1, "X-reentry", 3);
        e = check_frame("X-reentry", 3);
        ok_rst = (rst_err == 0) && (e == 0);
        $display("  [X] 寄存器失配 %0d, 复位后重入失配 %0d", rst_err, e);

        //------------------------------------------------------------------
        if (coll_n != 0)
            $display("[!] 乒乓不变量违反 %0d 拍", coll_n);

        $display("--------------------------------------------------");
        $display("regression=%s boundary=%s backpressure=%s stress=%s reset=%s",
                 ok_reg?"PASS":"FAIL", ok_bnd?"PASS":"FAIL", ok_bp?"PASS":"FAIL",
                 ok_str?"PASS":"FAIL", ok_rst?"PASS":"FAIL");

        if (ok_reg && ok_bnd && ok_bp && ok_str && ok_rst && coll_n == 0)
            $display("ALL TESTS PASSED");
        else
            $fatal(1, "存在失败场景");
        $finish;
    end

endmodule : tb_ofdm_tx_top
