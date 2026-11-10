//==============================================================================
// tb_eq_reset — 逐寄存器复位比对 (G-C-04)
//
// 为什么要单独一个: 另外三个 TB 只在**输出层面**验了复位 (m_axis_tvalid 归零 +
// 复位后整帧重入逐点正确)。那不等于逐寄存器 —— 内部某个计数器没复位, 只要它恰好
// 在下一帧被自然覆盖, 输出层面看不出来。
//
// 两条判据缺一不可:
//   T2 受复位控制的 26 个寄存器 -> 逐个等于其**声明的**复位值 (清单写死, 不通配)
//   T3 少复位的数据通路寄存器与存储阵列 -> 复位期间**保持不变, 不得被清零**
// T3 防的是反向漂移: 给数据通路加复位会阻断宏吸收、抬高控制集 (hdl §1.1)。
//
// T1 是前置条件, 也是本 TB 最容易被做废的地方: 注入复位**之前**必须先证明流水是脏的
// (valid 链有 1 / 两个 FIFO 非空 / 符号相位非 0)。对着一个本来就空的设计复位, 永远会过,
// 那样的 "PASS" 一点信息都没有。
//
// 运行 (从 rtl/ 目录):
//   iverilog -g2012 -o tb.out ../tb/tb_eq_reset.sv eq_zf.sv eq_recip.sv eq_reorder.sv && vvp tb.out
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_eq_reset;

    localparam int N = 64, NLTS = 2, NSYM = 48, NDATA = 48;
    localparam int NY = (NLTS + NSYM) * N, NH = NSYM * N, NX = NSYM * NDATA;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic [31:0] vec_y [0:NY-1], vec_h [0:NH-1], vec_x [0:NX-1];
    initial begin
        $readmemh("../vectors/y.hex",     vec_y);
        $readmemh("../vectors/h.hex",     vec_h);
        $readmemh("../vectors/x_exp.hex", vec_x);
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
    wire         o_erasure, o_y_overflow;

    eq_zf #(.P_YDEPTH(256)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_y_valid(i_y_valid), .i_y_re(i_y_re), .i_y_im(i_y_im),
        .i_y_idx(i_y_idx), .i_y_sb(i_y_sb),
        .s_axis_h_tvalid(s_h_tvalid), .s_axis_h_tready(s_h_tready), .s_axis_h_tdata(s_h_tdata),
        .m_axis_tvalid(m_tvalid), .m_axis_tready(m_tready), .m_axis_tdata(m_tdata),
        .o_erasure(o_erasure), .o_y_overflow(o_y_overflow));

    int fails = 0;
    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    int nreg = 0, nbad = 0;
    task automatic reg_is(input logic [63:0] got, input logic [63:0] want, input string nm);
        nreg++;
        if (got !== want) begin
            nbad++;
            $display("  [REG] %s = %0d, 声明复位值 %0d", nm, got, want);
        end
    endtask

    int nkeep = 0, nclr = 0;
    // 形参不能叫 before —— 那是 SystemVerilog 的保留字 (solve...before 约束)
    task automatic keep_is(input logic [63:0] got, input logic [63:0] prev, input string nm);
        nkeep++;
        if (got !== prev) begin
            nclr++;
            $display("  [KEEP] %s 复位期间被改动: %0h -> %0h (少复位数据通路不该动)", nm, prev, got);
        end
    endtask

    // ---- 驱动 (与 tb_eq_zf 同源, 含真实 CP 空窗) ----
    localparam int Y_GAP = 16;
    bit go = 1'b0, abort_v = 1'b0, y_busy = 1'b0, h_busy = 1'b0;

    initial forever begin
        int n;
        @(posedge go);
        y_busy = 1'b1;
        n = 0;
        while (n < NY && !abort_v) begin          // iverilog 不支持 break, 用条件退出
            @(negedge i_clk);
            i_y_valid = 1'b1; i_y_sb = (n == 0); i_y_idx = 6'(n % N);
            i_y_re = vec_y[n][15:0]; i_y_im = vec_y[n][31:16];
            if ((n % N) == (N-1)) begin
                @(negedge i_clk); i_y_valid = 1'b0; i_y_sb = 1'b0;
                repeat (Y_GAP - 1) @(negedge i_clk);
            end
            n = n + 1;
        end
        @(negedge i_clk); i_y_valid = 1'b0; i_y_sb = 1'b0;
        y_busy = 1'b0;
    end

    initial forever begin
        int n;
        @(posedge go);
        h_busy = 1'b1;
        repeat (80) @(negedge i_clk);      // 与真实链路同量级 (实测 H 滞后约 46 拍)
        n = 0;
        while (n < NH && !abort_v) begin
            @(negedge i_clk);
            s_h_tvalid = 1'b1; s_h_tdata = vec_h[n];
            if (s_h_tready) n = n + 1;
        end
        @(negedge i_clk); s_h_tvalid = 1'b0;
        h_busy = 1'b0;
    end

    // ---- 复位前采样的数据通路值 ----
    logic [31:0] s_ydat, s_rAy, s_rAh, s_rBh2, s_dly0, s_yfifo, s_ofifo, s_mem0, s_mem1, s_rotdat;
    logic [15:0] s_r2r0, s_ror1;
    int got_n = 0, mism = 0, guard = 0;

    always @(posedge i_clk) if (!i_rst && m_tvalid && m_tready) begin
        if (got_n < NX && m_tdata !== vec_x[got_n]) mism <= mism + 1;
        got_n <= got_n + 1;
    end

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);
        go = 1'b1; @(negedge i_clk); go = 1'b0;

        // 跑到流水灌满、两个 FIFO 都有货
        repeat (1400) @(posedge i_clk);

        //---- T1 前置条件: 状态必须是脏的, 否则后面全是废判据 ----
        chk(dut.r_seen === 1'b1 && dut.r_fsym !== 8'd0, "T1a 符号相位已推进 (r_seen=1, r_fsym!=0)");
        // 判"指针已推进"而不是"当前非空": H 一开始跑就把 FIFO 抽干 (Y 才是瓶颈,
        // 64 拍/80 周期), 而 H 不跑流水又是空的 —— 两者本质冲突。对复位而言真正要紧的
        // 是**指针处于非零的中途状态**, 复位必须把它们清零 (由 T2 验证)。
        chk(dut.r_ywr !== '0 && dut.r_yrd !== '0,
            $sformatf("T1b Y 路 FIFO 指针已推进 (wr=%0d rd=%0d)", dut.r_ywr, dut.r_yrd));
        chk(dut.r_hidx !== 6'd0 || dut.rA_valid || dut.rC_valid, "T1c H 侧/流水已在跑");
        chk(dut.u_reorder.r_full !== 2'b00 || dut.u_reorder.r_wj !== '0, "T1d 重排 bank 已在填");

        // 采样少复位的数据通路
        s_ydat  = dut.ri_ydat;      s_rAy   = dut.rA_y;        s_rAh = dut.rA_h;
        s_rBh2  = dut.rB_h2;        s_dly0  = dut.r_dly[0][31:0];
        s_yfifo = dut.r_yfifo[3];   s_ofifo = dut.r_ofifo[1][31:0];
        s_mem0  = dut.u_reorder.r_mem0[5][31:0];
        s_mem1  = dut.u_reorder.r_mem1[7][31:0];
        s_rotdat= dut.u_reorder.ro_tdata;
        s_r2r0  = dut.u_recip.r2_r0; s_ror1  = dut.u_recip.ro_r1;

        //---- 注入复位, 保持 3 拍 ----
        i_rst = 1'b1;
        repeat (3) @(posedge i_clk);
        #1;

        //---- T2 逐寄存器比对 (清单写死, 26 项) ----
        // eq_zf (13)
        reg_is(dut.ri_yv,     0, "eq_zf.ri_yv");
        reg_is(dut.ri_ysb,    0, "eq_zf.ri_ysb");
        reg_is(dut.r_fsym,    0, "eq_zf.r_fsym");
        reg_is(dut.r_seen,    0, "eq_zf.r_seen");
        reg_is(dut.r_ywr,     0, "eq_zf.r_ywr");
        reg_is(dut.r_yrd,     0, "eq_zf.r_yrd");
        reg_is(dut.ro_yovf,   0, "eq_zf.ro_yovf");
        reg_is(dut.r_hidx,    0, "eq_zf.r_hidx");
        reg_is(dut.rA_valid,  0, "eq_zf.rA_valid");
        reg_is(dut.rB_valid,  0, "eq_zf.rB_valid");
        reg_is(dut.rC_valid,  0, "eq_zf.rC_valid");
        reg_is(dut.rD_valid,  0, "eq_zf.rD_valid");
        reg_is(dut.r_owr,     0, "eq_zf.r_owr");
        reg_is(dut.r_ord,     0, "eq_zf.r_ord");
        // eq_recip (6)
        reg_is(dut.u_recip.ri_valid, 0, "eq_recip.ri_valid");
        reg_is(dut.u_recip.r1_valid, 0, "eq_recip.r1_valid");
        reg_is(dut.u_recip.r2_valid, 0, "eq_recip.r2_valid");
        reg_is(dut.u_recip.r3_valid, 0, "eq_recip.r3_valid");
        reg_is(dut.u_recip.r4_valid, 0, "eq_recip.r4_valid");
        reg_is(dut.u_recip.ro_valid, 0, "eq_recip.ro_valid");
        // eq_reorder (7)
        reg_is(dut.u_reorder.ri_valid,  0, "eq_reorder.ri_valid");
        reg_is(dut.u_reorder.r_wj,      0, "eq_reorder.r_wj");
        reg_is(dut.u_reorder.r_wb,      0, "eq_reorder.r_wb");
        reg_is(dut.u_reorder.r_rp,      0, "eq_reorder.r_rp");
        reg_is(dut.u_reorder.r_rb,      0, "eq_reorder.r_rb");
        reg_is(dut.u_reorder.r_full,    0, "eq_reorder.r_full");
        reg_is(dut.u_reorder.ro_tvalid, 0, "eq_reorder.ro_tvalid");

        chk(nbad == 0, $sformatf("T2 逐寄存器复位比对: %0d 项, 失配 %0d", nreg, nbad));
        chk(m_tvalid === 1'b0, "T2b 复位期间 m_axis_tvalid 为 0");

        //---- T3 少复位的**存储阵列与使能门控寄存器**不得被复位清零 ----
        // 判据范围刻意限定: ri_ydat / rA_y / rA_h / rB_h2 / r_dly[] 这类**无条件锁存**的
        // 流水寄存器不在其中 —— 它们每拍都跟着输入走, 复位期间上游若仍在驱动, 它们当然
        // 会变。"少复位"是**不加复位**, 不是"冻结"; 拿它们做 keep 判据只会测出激励在动。
        // 真正能证伪"有人给数据通路加了复位"的, 只有这四个**存储阵列**: 它们的写使能
        // (w_push / rD_valid / ri_valid) 全由已复位的 valid 链产生, 复位期间恒为 0,
        // 故必须原样保持。eq_recip 的 r2_r0/ro_r1 等也不在其中 —— 那些同样是无条件锁存。
        keep_is(dut.r_yfifo[3],                s_yfifo, "eq_zf.r_yfifo[3]");
        keep_is(dut.r_ofifo[1][31:0],          s_ofifo, "eq_zf.r_ofifo[1]");
        keep_is(dut.u_reorder.r_mem0[5][31:0], s_mem0,  "eq_reorder.r_mem0[5]");
        keep_is(dut.u_reorder.r_mem1[7][31:0], s_mem1,  "eq_reorder.r_mem1[7]");
        chk(nclr == 0, $sformatf("T3 少复位存储/使能门控寄存器未被清零: %0d 项, 被改 %0d (加复位会阻断宏吸收并抬高控制集)", nkeep, nclr));

        //---- T4 释放后重入一整帧, 逐点正确 ----
        abort_v = 1'b1;
        wait (!y_busy && !h_busy);
        repeat (4) @(negedge i_clk);
        got_n = 0; mism = 0; abort_v = 1'b0;
        i_rst = 1'b0;
        @(negedge i_clk);
        go = 1'b1; @(negedge i_clk); go = 1'b0;
        guard = 0;
        while (got_n < NX && guard < 400000) begin @(posedge i_clk); guard++; end
        repeat (100) @(posedge i_clk);
        chk(got_n == NX && mism == 0,
            $sformatf("T4 复位后重入整帧: 出 %0d/%0d, 失配 %0d", got_n, NX, mism));

        $display("");
        $display("REGS %0d BAD %0d KEEP %0d CLEARED %0d", nreg, nbad, nkeep, nclr);
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_eq_reset (%0d 条未过)", fails);
            $fatal(1, "tb_eq_reset: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_eq_reset");
        $finish;
    end

endmodule

`default_nettype wire
