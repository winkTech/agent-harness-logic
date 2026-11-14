//==============================================================================
// tb_mod_demapper — 解调器顶层判据 TB (**写在 mod_demapper.sv 之前**)
//
// 判据 0 容差: 期望值来自治理侧定点镜像 rtl_mirror_demap.m, 与 RTL 走同一条整数
// 路径, 任何差异都是缺陷而不是噪声。浮点锚 mod_demapper_llr 的角色在上一层 ——
// 它锁住镜像本身 (test_rtl_mirror_demap 的 T1), 不参与判卷。
//
// ## 接口在此定死, RTL 照着实现
//
//   上游  eq_zf 1.1.0 的 m_axis_tdata{im,re} + o_conf + o_erasure 直接对接
//   下游  ldpc_codec 吃**串行** LLR 流, 故本件每拍出一个 LLR, i_tlast 标记一个
//         符号的最后一个比特 —— 而不是一次并出 bps 个。并出会逼下游加一级拆分,
//         而拆分正是最容易把比特次序搞反的地方 (b0 在前这条约定已经踩过)。
//
// ## 判据
//   T0  复位期间 m_axis_tvalid 恒 0, 且复位后从第 0 点重入
//   T1  逐 LLR 0 容差比对 llr_exp.hex (2304 点 x bps)
//   T2  tlast 恰在每 bps 拍的最后一拍, 其余拍恒 0
//   T3  出入拍数守恒: 收到 = 送入 x bps, 不丢不重
//   T4  三种出侧反压与基准**逐点相同** (不是"也能跑完")
//   T5  上游断续注入与基准逐点相同
//   T6  erasure 载波单独判: 那 48 个点的 bps 个 LLR 必须全 0
//       —— 混在 2304 点里"没失配"不算数: 若 RTL 把 erasure 当普通点算, conf=0
//          恰好也会给出 0, 两条路径的错会互相遮掩。故单独把这批点拎出来判。
//   T7  符号中途复位: 不得残留半个符号
//
// 运行 (从 rtl/ 目录, 三档各跑一次):
//   iverilog -g2012 -o tb.out ../tb/tb_mod_demapper.sv mod_demapper.sv
//   vvp tb.out +VDIR=../analysis/vectors/16qam +BPS=4 +MOD=1
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_mod_demapper;

    localparam int DATA_W = 16;
    localparam int LLR_W  = 10;
    localparam int CONF_W = 12;
    localparam int MAXPT  = 2304;
    localparam int MAXLLR = MAXPT * 6;

    string vdir;
    int    BPS, MODSEL, NPT;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic [1:0]        r_mod    = 2'd1;
    logic              s_tvalid = 1'b0;
    wire               s_tready;
    logic [2*DATA_W-1:0] s_tdata = '0;
    logic [CONF_W-1:0] s_conf   = '0;
    logic              s_er     = 1'b0;

    wire                    m_tvalid;
    logic                   m_tready = 1'b1;
    wire signed [LLR_W-1:0] m_tdata;
    wire                    m_tlast;

    mod_demapper #(.P_DATA_W(DATA_W), .P_LLR_W(LLR_W), .P_CONF_W(CONF_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_mod(r_mod),
        .s_axis_tvalid(s_tvalid), .s_axis_tready(s_tready),
        .s_axis_tdata(s_tdata), .i_conf(s_conf), .i_erasure(s_er),
        .m_axis_tvalid(m_tvalid), .m_axis_tready(m_tready),
        .m_axis_tdata(m_tdata), .m_axis_tlast(m_tlast));

    //---- 向量 ----
    logic [2*DATA_W-1:0] x_mem  [0:MAXPT-1];
    logic [CONF_W-1:0]   cf_mem [0:MAXPT-1];
    logic [0:0]          er_mem [0:MAXPT-1];
    logic [LLR_W-1:0]    ll_mem [0:MAXLLR-1];

    //---- 采集 ----
    logic [LLR_W-1:0] cap      [0:MAXLLR-1];
    bit               cap_last [0:MAXLLR-1];
    logic [LLR_W-1:0] ref_cap  [0:MAXLLR-1];

    int sent = 0, got = 0, fails = 0, mism = 0;

    // 看门狗: 握手写错时 run_stream 会永久自旋。没有它, CI 上的表现是**挂死**而不是
    // 失败 —— 挂死要等超时才被发现, 且日志里没有任何指向。宁可多这十行。
    initial begin
        #(20 * MAXLLR * 40);
        $display("");
        $display("  [FAIL] 看门狗超时: 送入 %0d 点, 收到 %0d 个 LLR (期望 %0d)",
                 sent, got, NPT * BPS);
        $display("RESULT: FAIL - tb_mod_demapper (看门狗超时)");
        $fatal(1, "tb_mod_demapper: 看门狗超时");
    end

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    // 拍计数: 吞吐是**接口形状的依据**, 不能只在注释里算一遍就算数。
    // 串行输出成立的前提是 48 点 x bps < 每符号 400 拍 (100MHz / 20MHz@80样点),
    // 折合 <= 8.33 拍/点。T8 用实测拍数锁住它。
    int r_cyc = 0, c_first = 0, c_last = 0;
    always @(posedge i_clk) begin
        if (i_rst) r_cyc <= 0;
        else       r_cyc <= r_cyc + 1;
    end

    always @(posedge i_clk) begin
        if (!i_rst && m_tvalid && m_tready) begin
            if (got == 0) c_first <= r_cyc;
            c_last <= r_cyc;
            if (got < MAXLLR) begin
                cap[got]      <= m_tdata;
                cap_last[got] <= m_tlast;
            end
            got <= got + 1;
        end
    end

    //---- 出侧 tready 模式 ----
    int rd_mode = 0;
    always @(negedge i_clk) begin
        case (rd_mode)
            1: m_tready <= (($urandom % 4) != 0);        // 随机稀疏
            2: m_tready <= ((($time/10) % 60) < 40);     // 周期性长阻塞
            3: m_tready <= ~m_tready;                    // 每拍交替
            default: m_tready <= 1'b1;
        endcase
    end

    //---- 上游注入 (gap_mode!=0 时随机插空拍) ----
    task automatic run_stream(input int gap_mode);
        int i;
        i = 0;
        while (i < NPT) begin
            @(negedge i_clk);
            if (gap_mode != 0 && (($urandom % 5) == 0)) begin
                s_tvalid = 1'b0;
            end else begin
                s_tvalid = 1'b1;
                s_tdata  = x_mem[i];
                s_conf   = cf_mem[i];
                s_er     = er_mem[i][0];
                if (s_tready) begin i = i + 1; sent = sent + 1; end
            end
        end
        @(negedge i_clk);
        s_tvalid = 1'b0;
        s_er     = 1'b0;
    endtask

    task automatic run_all(input int rmode, input int gmode);
        i_rst = 1'b1; rd_mode = 0;
        repeat (4) @(negedge i_clk);
        sent = 0; got = 0;
        i_rst = 1'b0;
        @(negedge i_clk);
        rd_mode = rmode;
        run_stream(gmode);
        repeat (NPT * BPS * 4 + 2000) @(posedge i_clk);
        rd_mode = 0;
        repeat (4) @(negedge i_clk);
    endtask

    int k, p, b, nz, n_er_pt, bad_er;
    bit same, tl_ok;

    initial begin
        if (!$value$plusargs("VDIR=%s", vdir)) vdir = "../analysis/vectors/16qam";
        if (!$value$plusargs("BPS=%d", BPS))   BPS = 4;
        if (!$value$plusargs("MOD=%d", MODSEL)) MODSEL = 1;
        if (!$value$plusargs("NPT=%d", NPT))   NPT = MAXPT;
        r_mod = 2'(MODSEL);

        $readmemh($sformatf("%s/x.hex",       vdir), x_mem);
        $readmemh($sformatf("%s/conf.hex",    vdir), cf_mem);
        $readmemh($sformatf("%s/er.hex",      vdir), er_mem);
        // 显式给读取范围: 数组按 64QAM 的 13824 开, QPSK/16QAM 只有 4608/9216 个。
        // 不给范围的话每次都报一条"words 不够" —— 而**文件真被截断时是同一条警告**,
        // 留着它等于训练自己忽略它。
        $readmemh($sformatf("%s/llr_exp.hex", vdir), ll_mem, 0, NPT * BPS - 1);
        $display("  向量 %s  BPS=%0d MOD=%0d NPT=%0d", vdir, BPS, MODSEL, NPT);

        //---- T0a 复位期间不得有输出 ----
        repeat (6) @(posedge i_clk);
        chk(m_tvalid === 1'b0, "T0a 复位期间 m_axis_tvalid 恒 0");

        //---- T1/T2/T3 无反压基准 ----
        run_all(0, 0);
        chk(got == NPT * BPS,
            $sformatf("T3 出入守恒: 送入 %0d 点 x %0d = %0d, 收到 %0d",
                      sent, BPS, NPT * BPS, got));

        mism = 0;
        for (k = 0; k < NPT * BPS; k = k + 1) begin
            if (cap[k] !== ll_mem[k]) begin
                if (mism < 8)
                    $display("  [X] LLR #%0d (点 %0d 位 %0d) 得 %03X 期望 %03X",
                             k, k / BPS, k % BPS, cap[k], ll_mem[k]);
                mism = mism + 1;
            end
        end
        chk(mism == 0, $sformatf("T1 逐 LLR 0 容差比对镜像 (%0d 个): 失配 %0d",
                                 NPT * BPS, mism));

        // T8 吞吐: 每符号 400 拍要装下 48 点, 即 <= 8.33 拍/点。判据取整数 8。
        // 这条不过就意味着**串行输出这个接口形状本身不成立**, 得回去改接口,
        // 而不是调参数 —— 所以它必须是一条判据, 不能只是注释里的一次心算。
        chk((c_last - c_first) <= NPT * 8,
            $sformatf("T8 吞吐 %0d 拍 / %0d 点 = %0d.%0d 拍每点 (预算 8.33)",
                      c_last - c_first, NPT, (c_last - c_first) / NPT,
                      ((c_last - c_first) * 10 / NPT) % 10));

        tl_ok = 1'b1;
        for (k = 0; k < NPT * BPS; k = k + 1)
            if (cap_last[k] !== ((k % BPS) == (BPS - 1))) tl_ok = 1'b0;
        chk(tl_ok, "T2 tlast 恰在每符号最后一个比特, 其余拍恒 0");

        for (k = 0; k < NPT * BPS; k = k + 1) ref_cap[k] = cap[k];

        //---- T6 erasure 载波单独判 ----
        // 不能只看"混在 2304 点里没失配": 若 RTL 把 erasure 当普通点算, 而向量里
        // erasure 点的 conf 恰好也让数据通路给 0, 两条路径的错会互相遮掩。
        n_er_pt = 0; bad_er = 0;
        for (p = 0; p < NPT; p = p + 1) begin
            if (er_mem[p][0]) begin
                n_er_pt = n_er_pt + 1;
                nz = 0;
                for (b = 0; b < BPS; b = b + 1)
                    if (cap[p*BPS + b] !== {LLR_W{1'b0}}) nz = nz + 1;
                if (nz != 0) bad_er = bad_er + 1;
            end
        end
        chk(n_er_pt > 0 && bad_er == 0,
            $sformatf("T6 erasure 载波 %0d 个, 其 LLR 全 0 (违例 %0d)", n_er_pt, bad_er));

        //---- T4 三种出侧反压: 与基准逐点相同 ----
        for (k = 1; k <= 3; k = k + 1) begin
            same = 1'b1;
            run_all(k, 0);
            if (got != NPT * BPS) same = 1'b0;
            for (p = 0; p < NPT * BPS; p = p + 1)
                if (cap[p] !== ref_cap[p]) same = 1'b0;
            chk(same, $sformatf("T4 出侧反压模式 %0d 与基准逐点相同 (收到 %0d)", k, got));
        end

        //---- T5 上游断续注入 ----
        same = 1'b1;
        run_all(0, 1);
        if (got != NPT * BPS) same = 1'b0;
        for (p = 0; p < NPT * BPS; p = p + 1)
            if (cap[p] !== ref_cap[p]) same = 1'b0;
        chk(same, $sformatf("T5 上游断续注入与基准逐点相同 (收到 %0d)", got));

        //---- T7 符号中途复位: 不得残留 ----
        i_rst = 1'b1; rd_mode = 0;
        repeat (4) @(negedge i_clk);
        sent = 0; got = 0;
        i_rst = 1'b0;
        @(negedge i_clk);
        s_tvalid = 1'b1; s_tdata = x_mem[0]; s_conf = cf_mem[0]; s_er = 1'b0;
        repeat (12) @(negedge i_clk);
        i_rst = 1'b1; s_tvalid = 1'b0;
        repeat (6) @(posedge i_clk);
        chk(m_tvalid === 1'b0, "T7a 中途复位后 m_axis_tvalid 立即为 0");
        repeat (4) @(negedge i_clk);

        run_all(0, 0);
        mism = 0;
        for (k = 0; k < NPT * BPS; k = k + 1)
            if (cap[k] !== ll_mem[k]) mism = mism + 1;
        chk(got == NPT * BPS && mism == 0,
            $sformatf("T7b 复位后重入从第 0 点起 (收到 %0d, 失配 %0d)", got, mism));

        //---- 判决 ----
        $display("");
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_mod_demapper (%0d 条未过)", fails);
            $fatal(1, "tb_mod_demapper: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_mod_demapper");
        $finish;
    end

endmodule

`default_nettype wire
