//==============================================================================
// tb_ofdm_tx_top — ofdm_tx_top 定向自检 TB (ADR-004 架构)
// 场景:
//   T1-T4 四调制 (BPSK/QPSK/16QAM/64QAM) 各 3 符号: 输出与 TB 内浮点参考
//        (RTL 量化星座 → 网格 → DFT/8 → CP → Q3.13) 比对 ±TOL;
//        m_axis_tlast 于每符号第 80 拍; 导频极性逐符号交替
//   T5   QPSK 帧 + 随机 m_axis 反压: 与无反压基准逐点一致 (信用节流不丢重)
// 判据: 浮点参考 ±4 LSB (IFFT 截断/舍入累计, 冒烟实测 1 LSB);
//       bit-true 逐位由 tb_tx_cosim + generate_vectors 位真镜像承担。
// 尾部冲刷: 每帧后馈 2 个全零符号 (契约), 冲刷输出不计入比对。
// 失败路径: 一律 $fatal; 通过打印 "ALL TESTS PASSED"。
//==============================================================================
`timescale 1ns/1ps

module tb_ofdm_tx_top;

    localparam int  NSYM = 3;
    localparam int  TOL  = 4;
    localparam real PI   = 3.14159265358979;

    logic        clk = 0, rst;
    logic [3:0]  cfg_mod;
    logic [5:0]  s_tdata;
    logic        s_tvalid, s_tready;
    logic [31:0] m_tdata;
    logic        m_tvalid, m_tlast;
    logic        m_tready_r;
    int          bp_mode;

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
        if (bp_mode == 1) m_tready_r <= ($urandom_range(0, 3) != 0);
        else              m_tready_r <= 1'b1;
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
    int  bits_q [0:NSYM*48-1][0:5];
    real gr [0:NSYM-1][0:63], gi [0:NSYM-1][0:63];
    int  exp_i [0:NSYM*80-1], exp_q [0:NSYM*80-1];

    task automatic build_frame(input int mod, input int seed);
        int b[6], re, im, nb, d, s, n2;
        real yr, yi, ph, pol;
        real tr [0:63], ti [0:63];
        lcg = seed;
        nb = (mod==0) ? 1 : (mod==1) ? 2 : (mod==2) ? 4 : 6;
        for (s = 0; s < NSYM; s++) begin
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

    // 乒乓不变量: 收集侧永不写入正在流出的那个 bank。违反即数据被覆写 ——
    // 顶层符号信用 (≤2 在途) 是唯一保障, 信用记账一旦回绕就会在此暴露。
    always @(posedge clk) begin
        if (!rst && dut.u_pilot_map.i_valid && dut.u_pilot_map.r_sact &&
            (dut.u_pilot_map.r_wbank === dut.u_pilot_map.r_sbank))
            $fatal(1, "[pilot_map] 乒乓冲突: 写 bank %0d 正在流出 (wcnt=%0d scnt=%0d credit=%0d)",
                   dut.u_pilot_map.r_wbank, dut.u_pilot_map.r_wcnt,
                   dut.u_pilot_map.r_scnt, dut.r_credit);
    end

    task automatic send_group(input int b[6]);
        int unsigned w;
        s_tdata  <= {b[5]!=0, b[4]!=0, b[3]!=0, b[2]!=0, b[1]!=0, b[0]!=0};
        s_tvalid <= 1'b1;
        w = 0;
        do begin
            @(posedge clk); w++;
            if (w > 3000) $fatal(1, "send_group: s_tready 超时");
        end while (s_tready !== 1'b1);
    endtask

    task automatic run_frame(input int mod, input string tag);
        int b[6];
        int unsigned w;
        cap_i.delete(); cap_q.delete(); last_pos.delete();
        for (int s = 0; s < NSYM; s++)
            for (int d = 0; d < 48; d++) begin
                for (int j = 0; j < 6; j++) b[j] = bits_q[s*48+d][j];
                send_group(b);
            end
        for (int j = 0; j < 6; j++) b[j] = 0;    // 尾部冲刷 2 零符号
        repeat (96) send_group(b);
        s_tvalid <= 1'b0;
        w = 0;
        while (cap_i.size() < NSYM*80) begin
            @(posedge clk); w++;
            if (w > 30000) $fatal(1, "[%s] 输出超时: %0d/%0d", tag,
                                  cap_i.size(), NSYM*80);
        end
    endtask

    task automatic check_frame(input string tag);
        int nerr;
        nerr = 0;
        for (int n = 0; n < NSYM*80; n++) begin
            if (cap_i[n] - exp_i[n] > TOL || exp_i[n] - cap_i[n] > TOL ||
                cap_q[n] - exp_q[n] > TOL || exp_q[n] - cap_q[n] > TOL) begin
                if (nerr < 12)
                    $display("  [%s][DBG] n=%0d got=(%0d,%0d) exp=(%0d,%0d)",
                             tag, n, cap_i[n], cap_q[n], exp_i[n], exp_q[n]);
                nerr++;
            end
        end
        if (nerr != 0)
            $fatal(1, "[%s] %0d 点失配", tag, nerr);
        for (int s = 0; s < NSYM; s++) begin
            if (last_pos.size() <= s || last_pos[s] != s*80+79)
                $fatal(1, "[%s] tlast 错位: 符号 %0d", tag, s);
        end
        $display("  [%s] %0d 样点 ±%0d LSB + tlast 对齐", tag, NSYM*80, TOL);
    endtask

    task automatic reset_dut();
        @(posedge clk);
        rst <= 1'b1;
        repeat (5) @(posedge clk);
        rst <= 1'b0;
        repeat (3) @(posedge clk);
    endtask

    //==========================================================================
    // 主流程
    //==========================================================================
    int base_i [0:NSYM*80-1], base_q [0:NSYM*80-1];

    initial begin : p_watchdog
        #10ms;
        $fatal(1, "全局看门狗超时");
    end

    initial begin : p_main
        string names [0:3];
        names[0] = "BPSK"; names[1] = "QPSK";
        names[2] = "16QAM"; names[3] = "64QAM";
        rst = 1'b1; s_tvalid = 1'b0; s_tdata = '0; bp_mode = 0;
        cfg_mod = 4'd1;
        repeat (6) @(posedge clk);
        rst = 1'b0;
        repeat (3) @(posedge clk);

        for (int m = 0; m < 4; m++) begin
            $display("[T%0d] %s x %0d 符号", m+1, names[m], NSYM);
            reset_dut();
            cfg_mod = 4'(m);
            build_frame(m, 32'd20260801 + m);
            run_frame(m, names[m]);
            check_frame(names[m]);
        end

        //------------------------------------------------------------------
        $display("[T5] QPSK + 随机反压 (与基准逐点一致)");
        reset_dut();
        cfg_mod = 4'd1;
        build_frame(1, 32'd20260801 + 1);
        run_frame(1, "T5-base");
        for (int n = 0; n < NSYM*80; n++) begin
            base_i[n] = cap_i[n]; base_q[n] = cap_q[n];
        end
        reset_dut();
        bp_mode = 1;
        run_frame(1, "T5-bp");
        bp_mode = 0;
        for (int n = 0; n < NSYM*80; n++) begin
            if (cap_i[n] != base_i[n] || cap_q[n] != base_q[n])
                $fatal(1, "[T5] 反压下样点 %0d 不一致", n);
        end
        $display("  [T5] %0d 样点与无反压基准逐点一致", NSYM*80);

        $display("ALL TESTS PASSED");
        $finish;
    end

endmodule : tb_ofdm_tx_top
