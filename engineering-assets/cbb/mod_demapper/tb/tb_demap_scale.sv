//==============================================================================
// tb_demap_scale — 加权/移位/饱和末级的判据 TB (**写在 demap_scale.sv 之前**)
//
//   llr = sat10( (metric * wman + 2^(sh'-1)) >>> sh' ),  sh' = 67 - sh - log2K
//
// ## 本件最要紧的一条判据: sh' >= 48 的"可证恒 0"捷径
//
// 规格 (rtl_mirror_demap.m) 用了一条捷径: |metric*wman| <= 1.383e9 * 65024 =
// 8.99e13 < 2^46.4, 故 sh' >= 48 时 |积| < 2^(sh'-1), 结果**可证恒为 0**。
// 硬件照此省掉一个 67 位加法器 (sh'=66 时半量 = 2^65)。
//
// **捷径必须被验证而不是被相信**: 本 TB 的参考模型用 64 位全精度算完整式子, 不走
// 捷径。若捷径在某个 sh' 上不成立, 47/48 分界两侧会立刻分岔。T2 专打这条。
//
// ## 判据
//   T0 复位期间 o_valid 恒 0
//   T1 随机 2048 组对 64 位全精度参考 0 容差
//   T2 sh' 逐值扫 28..66 x {metric 极值, 典型值}: 47/48 分界两侧都对
//   T3 饱和: 必须钉在 +511/-512, **不得回绕** (回绕会变号)
//   T4 erasure 强制 0, 且与 metric/wman 无关
//   T5 流水线延迟恰为 5, o_valid 与 i_valid 一一对应
//
// 运行 (从 rtl/ 目录):
//   iverilog -g2012 -o tb.out ../tb/tb_demap_scale.sv demap_scale.sv && vvp tb.out
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_demap_scale;

    localparam int LLR_W = 10;
    localparam int LAT   = 5;
    localparam longint D2MAX = 64'd1382853904;          // (32768+4424)^2

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic               d_valid = 1'b0;
    logic signed [32:0] d_metric = '0;
    logic [15:0]        d_wman   = 16'h8000;
    logic [6:0]         d_shift  = 7'd40;
    logic               d_er     = 1'b0;

    wire                     d_ovalid;
    wire signed [LLR_W-1:0]  d_llr;

    demap_scale #(.P_LLR_W(LLR_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_valid(d_valid),
        .i_metric(d_metric), .i_wman(d_wman), .i_shift(d_shift), .i_erasure(d_er),
        .o_valid(d_ovalid), .o_llr(d_llr));

    int fails = 0;

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    //---- 参考模型: 64 位全精度, **不走 >=48 恒 0 的捷径** ----
    function automatic logic signed [LLR_W-1:0] ref_llr(
            input logic signed [32:0] met, input logic [15:0] wm,
            input logic [6:0] sh, input logic er);
        // **96 位而不是 64 位**: sh'=66 时半量 = 2^65, 在有符号 64 位里
        // `64'sd1 <<< 65` 会溢出成负数, 于是参考模型自己算出 -1 而 DUT 给 0。
        // 首版就栽在这儿 —— 而这正是硬件那条 ">=48 恒 0"捷径要绕开的同一类错误:
        // 它先咬了参考模型一口。参考模型必须有**足够余量**才配当参考。
        logic signed [95:0] p, h, q;
        p = $signed(met) * $signed({1'b0, wm});
        h = 96'sd1 <<< (sh - 7'd1);
        q = (p + h) >>> sh;
        if (er) q = 96'sd0;
        if (q >  96'sd511) q =  96'sd511;
        if (q < -96'sd512) q = -96'sd512;
        ref_llr = q[LLR_W-1:0];
    endfunction

    //---- 送入队列与在线比对 ----
    logic signed [32:0] q_met [0:8191];
    logic [15:0]        q_wm  [0:8191];
    logic [6:0]         q_sh  [0:8191];
    bit                 q_er  [0:8191];
    int wp = 0, rp = 0, nmis = 0, nout = 0;

    logic signed [LLR_W-1:0] e_llr;
    always @(posedge i_clk) begin
        if (!i_rst && d_ovalid) begin
            e_llr = ref_llr(q_met[rp], q_wm[rp], q_sh[rp], q_er[rp]);
            if (d_llr !== e_llr) begin
                if (nmis < 8)
                    $display("  [X] met=%0d wman=%0d sh'=%0d er=%0b 得 %0d 期望 %0d",
                             q_met[rp], q_wm[rp], q_sh[rp], q_er[rp], d_llr, e_llr);
                nmis = nmis + 1;
            end
            rp   = rp + 1;
            nout = nout + 1;
        end
    end

    task automatic send(input logic signed [32:0] met, input logic [15:0] wm,
                        input logic [6:0] sh, input logic er);
        @(negedge i_clk);
        d_valid = 1'b1; d_metric = met; d_wman = wm; d_shift = sh; d_er = er;
        q_met[wp] = met; q_wm[wp] = wm; q_sh[wp] = sh; q_er[wp] = er; wp = wp + 1;
        @(negedge i_clk);
        d_valid = 1'b0;
    endtask

    function automatic logic [15:0] mk_wman(input int man);
        mk_wman = 16'(32768 + man * 512);
    endfunction

    int  k, sh, nsent, lat_cnt;
    bit  lat_ok, sat_hi, sat_lo;
    logic signed [32:0] mv;

    initial begin
        //---- T0 ----
        repeat (6) @(posedge i_clk);
        chk(d_ovalid === 1'b0, "T0 复位期间 o_valid 恒 0");
        i_rst = 1'b0;
        @(negedge i_clk);

        //---- T5a 延迟 ----
        lat_cnt = 0; lat_ok = 1'b0;
        @(negedge i_clk);
        d_valid = 1'b1; d_metric = 33'sd1000; d_wman = 16'h8000; d_shift = 7'd30; d_er = 1'b0;
        q_met[wp] = 33'sd1000; q_wm[wp] = 16'h8000; q_sh[wp] = 7'd30; q_er[wp] = 1'b0; wp = wp + 1;
        @(negedge i_clk);
        d_valid = 1'b0;
        for (k = 1; k <= 12; k = k + 1) begin
            @(posedge i_clk);
            if (d_ovalid && !lat_ok) begin lat_cnt = k; lat_ok = 1'b1; end
        end
        chk(lat_cnt == LAT, $sformatf("T5a 流水线延迟 = %0d (期望 %0d)", lat_cnt, LAT));
        repeat (4) @(negedge i_clk);
        nsent = 1;

        //---- T2 sh' 逐值扫, 重点在 47/48 分界 ----
        nmis = 0;
        for (sh = 28; sh <= 66; sh = sh + 1) begin
            send( 33'(D2MAX),          16'hFE00, 7'(sh), 1'b0);   // 正极值 + 最大 wman
            send(-33'(D2MAX),          16'hFE00, 7'(sh), 1'b0);   // 负极值
            send( 33'(D2MAX),          16'h8000, 7'(sh), 1'b0);   // 正极值 + 最小 wman
            send( 33'sd1,              16'hFE00, 7'(sh), 1'b0);   // 最小非零
            send(-33'sd1,              16'hFE00, 7'(sh), 1'b0);
            send( 33'sd0,              16'hFE00, 7'(sh), 1'b0);
            send( 33'(D2MAX / 2),      16'hC000, 7'(sh), 1'b0);   // 典型值
            nsent = nsent + 7;
        end
        repeat (20) @(posedge i_clk);
        chk(nmis == 0,
            $sformatf("T2 sh' 扫 28..66 (含 47/48 分界) 对全精度参考 0 容差: 失配 %0d", nmis));

        //---- T3 饱和: 小 sh' + 大积 必须钉在 ±511/512 ----
        nmis = 0; sat_hi = 1'b0; sat_lo = 1'b0;
        for (k = 0; k < 64; k = k + 1) begin
            mv = 33'(D2MAX - k);
            send( mv, 16'hFE00, 7'd28, 1'b0);
            send(-mv, 16'hFE00, 7'd28, 1'b0);
            nsent = nsent + 2;
        end
        repeat (20) @(posedge i_clk);
        // 参考模型自身也做饱和, 故 T2/T3 的 0 容差已覆盖"不回绕";
        // 这里再单独确认确实**打到了**饱和, 否则判据是空转的
        for (k = 0; k < wp; k = k + 1) begin
            if (ref_llr(q_met[k], q_wm[k], q_sh[k], q_er[k]) ===  10'sd511) sat_hi = 1'b1;
            if (ref_llr(q_met[k], q_wm[k], q_sh[k], q_er[k]) === -10'sd512) sat_lo = 1'b1;
        end
        chk(nmis == 0 && sat_hi && sat_lo,
            $sformatf("T3 饱和: 失配 %0d, 触顶 %0b 触底 %0b (须都为 1, 否则判据空转)",
                      nmis, sat_hi, sat_lo));

        //---- T4 erasure 强制 0 ----
        nmis = 0;
        for (k = 0; k < 64; k = k + 1) begin
            send(33'($urandom), mk_wman($urandom % 64), 7'(28 + ($urandom % 39)), 1'b1);
            nsent = nsent + 1;
        end
        repeat (20) @(posedge i_clk);
        chk(nmis == 0, $sformatf("T4 erasure 强制 0 (与 metric/wman 无关): 失配 %0d", nmis));

        //---- T1 随机 ----
        nmis = 0;
        for (k = 0; k < 2048; k = k + 1) begin
            mv = 33'($urandom % (2 * D2MAX)) - 33'(D2MAX);      // 落在可证域内
            send(mv, mk_wman($urandom % 64), 7'(28 + ($urandom % 39)), 1'b0);
            nsent = nsent + 1;
        end
        repeat (20) @(posedge i_clk);
        chk(nmis == 0, $sformatf("T1 随机 2048 组 0 容差: 失配 %0d", nmis));

        chk(nout == nsent, $sformatf("T5b o_valid 一一对应: 送 %0d 出 %0d", nsent, nout));

        $display("");
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_demap_scale (%0d 条未过)", fails);
            $fatal(1, "tb_demap_scale: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_demap_scale");
        $finish;
    end

endmodule

`default_nettype wire
