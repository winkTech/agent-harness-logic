//==============================================================================
// tb_demap_reset — 逐寄存器复位比对 (G-C-04)
//
// 为什么要单独一个: 另外三个 TB 只在**输出层面**验了复位 (m_axis_tvalid 归零 + 复位后
// 整帧重入逐点正确)。那不等于逐寄存器 —— 内部某个计数器没复位, 只要它恰好在下一帧被
// 自然覆盖, 输出层面就看不出来。
//
// 三条判据缺一不可:
//   T2  受复位控制的 36 个寄存器 -> 逐个等于其**声明的**复位值 (清单写死, 不通配)
//   T3a 少复位且在复位期间条件为假的寄存器 -> **逐位不变**
//   T3b 少复位但仍自由跑的寄存器 -> **不得被清零**
// T3 防的是反向漂移: 给数据通路加复位会抬高控制集, 且 r2_sq / r1_prod 是乘法器输出
// 寄存器, 带复位会挡住 DSP 内部寄存器吸收 (hdl §1.1)。少复位是**有意的**, 谁顺手补上
// 就会在 T3 上失败 —— 这正是要的效果。
//
// T1 是前置条件, 也是本 TB 最容易被做废的地方: 注入复位**之前**必须先证明流水是脏的
// (valid 链有 1 / 出侧 FIFO 非空 / 信用被扣 / 串行化在半途)。对着一个本来就空的设计
// 复位, 永远会过, 那样的 "PASS" 一点信息都没有。
//
// T0b 是本 TB 立项时才看出来的一条: **复位期间 s_axis_tready 必须为 0**。三个功能 TB
// 全绿也漏掉了它 —— 它们复位时不驱动 tvalid, 于是握手根本不发生。
//
// 运行 (从 rtl/ 目录):
//   iverilog -g2012 -o tb.out ../tb/tb_demap_reset.sv mod_demapper.sv demap_metric.sv demap_scale.sv
//   vvp tb.out
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_demap_reset;

    localparam int DATA_W = 16, LLR_W = 10, CONF_W = 12;
    localparam int OFD    = 16;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic [1:0]        r_mod    = 2'd2;              // 64QAM: bps 最大, 串行化最长
    logic              s_tvalid = 1'b0;
    wire               s_tready;
    logic [31:0]       s_tdata  = '0;
    logic [CONF_W-1:0] s_conf   = '0;
    logic              s_er     = 1'b0;

    wire                    m_tvalid;
    logic                   m_tready = 1'b0;         // 刻意不收, 让出侧 FIFO 填满
    wire signed [LLR_W-1:0] m_tdata;
    wire                    m_tlast;

    mod_demapper #(.P_DATA_W(DATA_W), .P_LLR_W(LLR_W), .P_CONF_W(CONF_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_mod(r_mod),
        .s_axis_tvalid(s_tvalid), .s_axis_tready(s_tready),
        .s_axis_tdata(s_tdata), .i_conf(s_conf), .i_erasure(s_er),
        .m_axis_tvalid(m_tvalid), .m_axis_tready(m_tready),
        .m_axis_tdata(m_tdata), .m_axis_tlast(m_tlast));

    int nreg = 0, nbad = 0, nkeep = 0, nclr = 0, fails = 0;

    // 看门狗。本 TB 刻意把出侧堵死来灌脏流水, 一不小心就灌过头 —— 出侧 FIFO 只有
    // OFD 个位置, 64QAM 一个点就要 6 个, 灌到第三个点 s_tready 就永久为 0。
    // 首版正是这么挂住的, 而且**一行输出都没有**。没有看门狗的 TB 在 CI 上是挂死
    // 而不是失败, 挂死要等外层超时才被发现且日志无指向。
    initial begin
        #2_000_000;
        $display("");
        $display("  [FAIL] 看门狗超时 —— 多半卡在等 s_axis_tready (出侧堵死后灌入过量)");
        $display("RESULT: FAIL - tb_demap_reset (看门狗超时)");
        $fatal(1, "tb_demap_reset: 看门狗超时");
    end

    // 带上限的送入: 出侧堵死时 s_tready 会永久为 0, 不能无限等
    int guard;
    task automatic push_bounded(input int lim, output bit accepted);
        guard = 0;
        accepted = 1'b0;
        while (!accepted && guard < lim) begin
            @(negedge i_clk);
            if (s_tready) accepted = 1'b1;
            else          guard = guard + 1;
        end
    endtask

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    // T2: 受复位控制的寄存器 —— 逐个对其**声明的**复位值
    task automatic reg_is(input logic [63:0] got, input logic [63:0] want, input string nm);
        nreg++;
        if (got !== want) begin
            nbad++;
            $display("  [X] %s = %0d, 声明的复位值是 %0d", nm, got, want);
        end
    endtask

    // T3a: 少复位且条件为假 —— 必须逐位不变
    task automatic keep_is(input logic [63:0] got, input logic [63:0] was, input string nm);
        nkeep++;
        if (got !== was) begin
            nbad++;
            $display("  [X] %s 被复位改动了: %0h -> %0h (该寄存器是**有意少复位**的)", nm, was, got);
        end
    endtask

    // T3b: 少复位但自由跑 —— 至少不得被清零
    task automatic notclr(input logic [63:0] got, input string nm);
        nclr++;
        if (got === 64'd0) begin
            nbad++;
            $display("  [X] %s 被清零了 —— 数据通路不该有复位扇入", nm);
        end
    endtask

    logic [63:0] s_rix, s_riw, s_ris;
    logic [63:0] s_h0, s_h5, s_hw, s_hs;
    logic [63:0] s_c0, s_c5, s_cw, s_cs;
    logic [63:0] s_fifo3, s_fifo7;
    logic [63:0] s_riy, s_d3, s_sq5, s_rom0;
    logic [63:0] s_prod, s_sum, s_llr;

    int i;
    bit acc;

    initial begin
        //---- T0a 复位期间输出侧 ----
        repeat (6) @(posedge i_clk);
        chk(m_tvalid === 1'b0, "T0a 复位期间 m_axis_tvalid 恒 0");

        //---- T0b 复位期间入侧 tready 必须为 0 ----
        // 少了这条, 上游保持 tvalid 时握手成立、数据被吃掉, 而 ri_valid 被复位钳住 ——
        // 数据静默丢失, 上游还以为发出去了。
        s_tvalid = 1'b1; s_tdata = 32'hDEAD_BEEF; s_conf = 12'h5A5;
        repeat (3) @(posedge i_clk);
        chk(s_tready === 1'b0, "T0b 复位期间 s_axis_tready 恒 0 (否则复位期数据静默丢失)");
        @(negedge i_clk);
        s_tvalid = 1'b0;

        //---- 放开复位, 把流水灌脏 ----
        // 两段: 先开着出侧正常跑一批 (让各级都装上真实数据), 再堵死出侧灌到 FIFO 满、
        // 信用扣光、串行化停在半途 —— 那才是"脏"的完整形状。
        i_rst = 1'b0;
        @(negedge i_clk);
        m_tready = 1'b1;
        for (i = 0; i < 20; i++) begin
            @(negedge i_clk);
            s_tvalid = 1'b1;
            s_tdata  = {16'($urandom % 30000), 16'($urandom % 30000)};
            // sh 取高段 (28..34): 64QAM 下 sh' = 67-sh-5 ∈ [28,34], LLR 必非零。
            // 首版用 sh∈[10,29], sh<=14 时 sh'>=48 -> LLR 恒 0, 于是 ofifo[3] 采到 0,
            // T3a 对它的"复位后不变"就成了空转 —— 判据没错, 是激励没给出内容。
            s_conf   = 12'((28 + ($urandom % 7)) * 64 + ($urandom % 64));
            s_er     = 1'b0;
            push_bounded(400, acc);
            if (!acc) i = 100;                       // iverilog 无 break
        end
        m_tready = 1'b0;                             // 堵死出侧
        for (i = 0; i < 6; i++) begin
            @(negedge i_clk);
            s_tvalid = 1'b1;
            s_tdata  = {16'($urandom % 30000), 16'($urandom % 30000)};
            // sh 取高段 (28..34): 64QAM 下 sh' = 67-sh-5 ∈ [28,34], LLR 必非零。
            // 首版用 sh∈[10,29], sh<=14 时 sh'>=48 -> LLR 恒 0, 于是 ofifo[3] 采到 0,
            // T3a 对它的"复位后不变"就成了空转 —— 判据没错, 是激励没给出内容。
            s_conf   = 12'((28 + ($urandom % 7)) * 64 + ($urandom % 64));
            push_bounded(60, acc);                   // 堵住后收不下是预期的, 不再等
            if (!acc) i = 100;
        end
        @(negedge i_clk);
        s_tvalid = 1'b0;
        repeat (10) @(posedge i_clk);

        //---- T1 注入复位前必须证明流水是脏的 ----
        chk(dut.r_owp !== dut.r_orp,       "T1a 出侧 FIFO 非空 (读写指针不等)");
        chk(dut.r_credit !== 5'd16,        "T1b 信用已被扣 (出侧有在途数据)");
        chk(dut.r_state !== 1'b0 || dut.r_bit !== 3'd0 || dut.r_hold_v !== 1'b0,
                                           "T1c 串行化在半途或保持寄存器有货");
        // 注: 出侧堵死后末级 valid 链**本就该排空** (信用扣光 -> 不再发拍 -> 5 拍内走空),
        // 所以"末级有 valid"在这个场景下物理上不成立, 不能拿来当脏的证据。
        // 脏的证据是上面三条 (FIFO 非空 / 信用被扣 / 串行化在半途) 加下面的 T1d。

        //---- 采样"有意少复位"的寄存器 ----
        s_rix  = dut.ri_x;        s_riw = dut.ri_wman;   s_ris = dut.ri_shift;
        s_h0   = dut.r_h[0];      s_h5  = dut.r_h[5];
        s_hw   = dut.r_h_wman;    s_hs  = dut.r_h_shift;
        s_c0   = dut.r_c[0];      s_c5  = dut.r_c[5];
        s_cw   = dut.r_c_wman;    s_cs  = dut.r_c_shift;
        s_fifo3= dut.r_ofifo[3];  s_fifo7 = dut.r_ofifo[7];
        s_riy  = dut.u_mi.ri_y;   s_d3  = dut.u_mi.r1_d[3];
        s_sq5  = dut.u_mi.r2_sq[5]; s_rom0 = dut.u_mi.ro_m0;
        s_prod = dut.u_scale.r1_prod; s_sum = dut.u_scale.r2_sum;
        s_llr  = dut.u_scale.ro_llr;

        // T1d: T3 的真正前提 —— 采到的少复位寄存器必须**确实装着东西**。
        // 若它们本来就是 0, "复位后仍不变" 会永远成立, 那样的 T3 一点信息都没有。
        $display("    采样值: ri_x=%0h r_h[0]=%0h r_c[0]=%0h ofifo[3]=%0h prod=%0h sum=%0h",
                 s_rix, s_h0, s_c0, s_fifo3, s_prod, s_sum);
        chk(s_rix !== 64'd0 && s_h0 !== 64'd0 && s_c0 !== 64'd0 && s_fifo3 !== 64'd0 &&
            s_prod !== 64'd0 && s_sum !== 64'd0,
            "T1d 采样到的少复位寄存器确实非零 (否则 T3 是空转的)");

        //---- 注入复位 ----
        @(negedge i_clk);
        i_rst = 1'b1;
        repeat (4) @(posedge i_clk);
        @(negedge i_clk);

        //================= T2 受复位控制的 36 个寄存器 =================
        // 顶层 (15)
        reg_is(dut.ri_valid,   0,     "mod_demapper.ri_valid");
        reg_is(dut.ri_mod,     0,     "mod_demapper.ri_mod");
        reg_is(dut.ri_er,      0,     "mod_demapper.ri_er");
        reg_is(dut.r_inflight, 0,     "mod_demapper.r_inflight");
        reg_is(dut.r_state,    0,     "mod_demapper.r_state (S_IDLE)");
        reg_is(dut.r_hold_v,   0,     "mod_demapper.r_hold_v");
        reg_is(dut.r_bit,      0,     "mod_demapper.r_bit");
        reg_is(dut.r_c_er,     0,     "mod_demapper.r_c_er");
        reg_is(dut.r_c_bps,    2,     "mod_demapper.r_c_bps (=2)");
        reg_is(dut.r_h_er,     0,     "mod_demapper.r_h_er");
        reg_is(dut.r_h_mod,    0,     "mod_demapper.r_h_mod");
        reg_is(dut.r_lastpipe, 0,     "mod_demapper.r_lastpipe");
        reg_is(dut.r_owp,      0,     "mod_demapper.r_owp");
        reg_is(dut.r_orp,      0,     "mod_demapper.r_orp");
        reg_is(dut.r_credit,   OFD,   "mod_demapper.r_credit (=OFD)");

        // demap_metric x2 (12)
        reg_is(dut.u_mi.ri_valid, 0, "u_mi.ri_valid");
        reg_is(dut.u_mi.ri_mod,   0, "u_mi.ri_mod");
        reg_is(dut.u_mi.r1_valid, 0, "u_mi.r1_valid");
        reg_is(dut.u_mi.r2_valid, 0, "u_mi.r2_valid");
        reg_is(dut.u_mi.r3_valid, 0, "u_mi.r3_valid");
        reg_is(dut.u_mi.ro_valid, 0, "u_mi.ro_valid");
        reg_is(dut.u_mq.ri_valid, 0, "u_mq.ri_valid");
        reg_is(dut.u_mq.ri_mod,   0, "u_mq.ri_mod");
        reg_is(dut.u_mq.r1_valid, 0, "u_mq.r1_valid");
        reg_is(dut.u_mq.r2_valid, 0, "u_mq.r2_valid");
        reg_is(dut.u_mq.r3_valid, 0, "u_mq.r3_valid");
        reg_is(dut.u_mq.ro_valid, 0, "u_mq.ro_valid");

        // demap_scale (9)
        reg_is(dut.u_scale.ri_valid, 0, "u_scale.ri_valid");
        reg_is(dut.u_scale.ri_er,    0, "u_scale.ri_er");
        reg_is(dut.u_scale.r1_valid, 0, "u_scale.r1_valid");
        reg_is(dut.u_scale.r1_er,    0, "u_scale.r1_er");
        reg_is(dut.u_scale.r1_big,   0, "u_scale.r1_big");
        reg_is(dut.u_scale.r2_valid, 0, "u_scale.r2_valid");
        reg_is(dut.u_scale.r2_zero,  0, "u_scale.r2_zero");
        reg_is(dut.u_scale.r3_valid, 0, "u_scale.r3_valid");
        reg_is(dut.u_scale.ro_valid, 0, "u_scale.ro_valid");

        chk(nbad == 0, $sformatf("T2 %0d 个受复位寄存器逐项等于声明值 (违例 %0d)", nreg, nbad));

        //================= T3a 少复位且条件为假 -> 逐位不变 =================
        // 这些的写使能在复位期间恒假 (w_accept / w_mv_i / w_load / w_sv 全被 valid 链钳住),
        // 故它们必须**一位都不动**。
        keep_is(dut.ri_x,        s_rix,  "mod_demapper.ri_x");
        keep_is(dut.ri_wman,     s_riw,  "mod_demapper.ri_wman");
        keep_is(dut.ri_shift,    s_ris,  "mod_demapper.ri_shift");
        keep_is(dut.r_h[0],      s_h0,   "mod_demapper.r_h[0]");
        keep_is(dut.r_h[5],      s_h5,   "mod_demapper.r_h[5]");
        keep_is(dut.r_h_wman,    s_hw,   "mod_demapper.r_h_wman");
        keep_is(dut.r_h_shift,   s_hs,   "mod_demapper.r_h_shift");
        keep_is(dut.r_c[0],      s_c0,   "mod_demapper.r_c[0]");
        keep_is(dut.r_c[5],      s_c5,   "mod_demapper.r_c[5]");
        keep_is(dut.r_c_wman,    s_cw,   "mod_demapper.r_c_wman");
        keep_is(dut.r_c_shift,   s_cs,   "mod_demapper.r_c_shift");
        keep_is(dut.r_ofifo[3],  s_fifo3,"mod_demapper.r_ofifo[3]");
        keep_is(dut.r_ofifo[7],  s_fifo7,"mod_demapper.r_ofifo[7]");
        keep_is(dut.u_mi.ri_y,   s_riy,  "u_mi.ri_y");

        //================= T3b 少复位但自由跑 -> 至少不得被清零 =================
        // 这几个是无条件寄存 (每拍都跟着输入走), 复位期间输入被上游的 valid 链钳成
        // 稳态, 值可能变一次再稳住 —— 判据只能是"没有复位扇入把它清零"。
        // 判"非零"是有意义的: 若谁给它加了同步复位, 这里立刻是 0。
        notclr(dut.u_mi.r1_d[3],      "u_mi.r1_d[3]");
        notclr(dut.u_mi.r2_sq[5],     "u_mi.r2_sq[5]");
        notclr(dut.u_mi.ro_m0,        "u_mi.ro_m0");
        notclr(dut.u_scale.r1_prod,   "u_scale.r1_prod (乘法器输出寄存器)");
        notclr(dut.u_scale.r2_sum,    "u_scale.r2_sum");

        chk(nbad == 0, $sformatf("T3 少复位: %0d 项逐位不变 + %0d 项未被清零 (违例 %0d)",
                                 nkeep, nclr, nbad));

        //---- 复位后能否正常重入 (功能 TB 已覆盖, 这里只做存在性确认) ----
        i_rst = 1'b0;
        @(negedge i_clk);
        m_tready = 1'b1;
        for (i = 0; i < 8; i++) begin
            @(negedge i_clk);
            s_tvalid = 1'b1; s_tdata = 32'h0800_0800; s_conf = 12'((20*64) + 32);
            while (!s_tready) @(negedge i_clk);
        end
        @(negedge i_clk); s_tvalid = 1'b0;
        repeat (60) @(posedge i_clk);
        chk(dut.r_owp !== 5'd0 || dut.r_orp !== 5'd0, "T4 复位后能重新出数");

        $display("");
        $display("REGS %0d  BAD %0d  KEEP %0d  NOTCLR %0d", nreg, nbad, nkeep, nclr);
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_demap_reset (%0d 条未过)", fails);
            $fatal(1, "tb_demap_reset: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_demap_reset");
        $finish;
    end

endmodule

`default_nettype wire
