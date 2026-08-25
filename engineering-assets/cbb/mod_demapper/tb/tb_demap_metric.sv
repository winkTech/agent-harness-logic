//==============================================================================
// tb_demap_metric — 单轴 max-log metric 的判据 TB (**写在 demap_metric.sv 之前**)
//
// DUT 用**硬连的 4 路 min 树** (掩码是常数, 综合后就是固定的比较网络)。
// 本 TB 的参考模型刻意用**另一种写法**: 对 8 个槽位循环求 min。两者结构不同,
// 才谈得上互证 —— 若参考模型也照抄 4 路树, 那测的只是"我把同一段代码写了两遍"。
//
// ## 8 槽位统一化 (DUT 与本 TB 共同的前提, 由 rtl_mirror_demap 的标号导出)
//
//   QPSK  槽 0-3 = -2896, 槽 4-7 = +2896                    (每电平复制 4 份)
//   16QAM 槽 0,1=-3886 2,3=-1295 4,5=+1295 6,7=+3886        (每电平复制 2 份)
//   64QAM 槽 0..7 = -4424 -3160 -1896 -632 +632 +1896 +3160 +4424
//
//   比特掩码**与调制无关** —— Gray 标号是嵌套的, 这是查出来的不是凑的:
//     b0 槽 4..7 为 1    -> 8'b1111_0000
//     b1 槽 2..5 为 1    -> 8'b0011_1100
//     b2 槽 1,2,5,6 为 1 -> 8'b0110_0110
//
//   复制的副作用正好是想要的: QPSK 的 m1/m2 与 16QAM 的 m2 **恒为 0**, 因为
//   掩码两侧取到的是同一组电平。故上层无须按调制屏蔽 —— T4 锁住这一点。
//
// ## 判据
//   T0 复位期间 o_valid 恒 0
//   T1 三档 x 随机 512 点: 三个 metric 全部对参考模型 0 容差
//   T2 边界: 恰在电平上 / 紧贴中点 / 冲出星座外 —— min 树的比较写反会在这里分岔
//   T3 流水线延迟恰为 5, 且 o_valid 与 i_valid 一一对应 (不吞不吐)
//   T4 QPSK 的 m1/m2 与 16QAM 的 m2 恒为 0 (嵌套 Gray 的推论)
//
// 运行 (从 rtl/ 目录):
//   iverilog -g2012 -o tb.out ../tb/tb_demap_metric.sv demap_metric.sv && vvp tb.out
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_demap_metric;

    localparam int DATA_W = 16;
    localparam int LAT    = 5;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic                     d_valid = 1'b0;
    logic signed [DATA_W-1:0] d_y     = '0;
    logic [1:0]               d_mod   = 2'd0;

    wire                d_ovalid;
    wire signed [32:0]  d_m0, d_m1, d_m2;

    demap_metric #(.P_DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(d_valid), .i_y(d_y), .i_mod(d_mod),
        .o_valid(d_ovalid), .o_m0(d_m0), .o_m1(d_m1), .o_m2(d_m2));

    int fails = 0;

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    //---- 参考模型: 对 8 槽位循环, 与 DUT 的固定 4 路树结构不同 ----
    function automatic logic signed [15:0] ref_lev(input logic [1:0] m, input int j);
        case (m)
            2'd0: ref_lev = (j < 4) ? -16'sd2896 : 16'sd2896;
            2'd1: case (j / 2)
                      0: ref_lev = -16'sd3886;
                      1: ref_lev = -16'sd1295;
                      2: ref_lev =  16'sd1295;
                      default: ref_lev = 16'sd3886;
                  endcase
            default: case (j)
                      0: ref_lev = -16'sd4424;
                      1: ref_lev = -16'sd3160;
                      2: ref_lev = -16'sd1896;
                      3: ref_lev =  -16'sd632;
                      4: ref_lev =   16'sd632;
                      5: ref_lev =  16'sd1896;
                      6: ref_lev =  16'sd3160;
                      default: ref_lev = 16'sd4424;
                  endcase
        endcase
    endfunction

    function automatic logic [7:0] ref_mask(input int b);
        case (b)
            0: ref_mask = 8'b1111_0000;
            1: ref_mask = 8'b0011_1100;
            default: ref_mask = 8'b0110_0110;
        endcase
    endfunction

    // 循环式: 逐槽位比较累积, 不用任何树形结构
    function automatic logic signed [32:0] ref_metric(
            input logic [1:0] m, input logic signed [15:0] y, input int b);
        // iverilog 12 不认 signed'() 转型, 一律用 $signed()
        logic [7:0]         msk;
        logic signed [63:0] mn1, mn0, dd, sq;
        int                 j;
        msk = ref_mask(b);
        mn1 = 64'sh7FFF_FFFF_FFFF_FFFF;
        mn0 = 64'sh7FFF_FFFF_FFFF_FFFF;
        for (j = 0; j < 8; j = j + 1) begin
            dd = $signed(y) - $signed(ref_lev(m, j));
            sq = dd * dd;
            if (msk[j]) begin if (sq < mn1) mn1 = sq; end
            else        begin if (sq < mn0) mn0 = sq; end
        end
        ref_metric = mn1 - mn0;
    endfunction

    //---- 送一拍并在 LAT 拍后比对 ----
    logic signed [15:0] q_y   [0:1023];
    logic [1:0]         q_mod [0:1023];
    bit                 q_vld [0:1023];
    int wp = 0, rp = 0, nmis = 0, nout = 0;

    logic signed [32:0] e0, e1, e2;
    always @(posedge i_clk) begin
        if (!i_rst && d_ovalid) begin
            e0 = ref_metric(q_mod[rp], q_y[rp], 0);
            e1 = ref_metric(q_mod[rp], q_y[rp], 1);
            e2 = ref_metric(q_mod[rp], q_y[rp], 2);
            if (d_m0 !== e0 || d_m1 !== e1 || d_m2 !== e2) begin
                if (nmis < 6)
                    $display("  [X] mod=%0d y=%0d 得 (%0d,%0d,%0d) 期望 (%0d,%0d,%0d)",
                             q_mod[rp], q_y[rp], d_m0, d_m1, d_m2, e0, e1, e2);
                nmis = nmis + 1;
            end
            // T4: 嵌套 Gray 的推论
            if (q_mod[rp] == 2'd0 && (d_m1 !== 33'sd0 || d_m2 !== 33'sd0)) begin
                $display("  [X] QPSK m1/m2 应恒 0, 得 (%0d,%0d)", d_m1, d_m2);
                nmis = nmis + 1;
            end
            if (q_mod[rp] == 2'd1 && d_m2 !== 33'sd0) begin
                $display("  [X] 16QAM m2 应恒 0, 得 %0d", d_m2);
                nmis = nmis + 1;
            end
            rp   = rp + 1;
            nout = nout + 1;
        end
    end

    task automatic send(input logic [1:0] m, input logic signed [15:0] y);
        @(negedge i_clk);
        d_valid = 1'b1; d_mod = m; d_y = y;
        q_y[wp] = y; q_mod[wp] = m; q_vld[wp] = 1'b1; wp = wp + 1;
        @(negedge i_clk);
        d_valid = 1'b0;
    endtask

    int  k, nsent;
    bit  lat_ok;
    int  lat_cnt;

    initial begin
        //---- T0 复位期间无输出 ----
        repeat (6) @(posedge i_clk);
        chk(d_ovalid === 1'b0, "T0 复位期间 o_valid 恒 0");
        i_rst = 1'b0;
        @(negedge i_clk);

        //---- T3 流水线延迟恰为 5 ----
        lat_cnt = 0;
        @(negedge i_clk);
        d_valid = 1'b1; d_mod = 2'd2; d_y = 16'sd1000;
        q_y[wp] = 16'sd1000; q_mod[wp] = 2'd2; wp = wp + 1;
        @(negedge i_clk);
        d_valid = 1'b0;
        lat_ok = 1'b0;
        for (k = 1; k <= 12; k = k + 1) begin
            @(posedge i_clk);
            if (d_ovalid && !lat_ok) begin lat_cnt = k; lat_ok = 1'b1; end
        end
        chk(lat_cnt == LAT, $sformatf("T3a 流水线延迟 = %0d (期望 %0d)", lat_cnt, LAT));
        repeat (4) @(negedge i_clk);

        //---- T2 边界 (先跑, 失败时信息最干净) ----
        nsent = 0;
        for (k = 0; k < 3; k = k + 1) begin
            send(2'(k), 16'sd0);                      // 原点
            send(2'(k), ref_lev(2'(k), 0));           // 恰在最低电平上
            send(2'(k), ref_lev(2'(k), 7));           // 恰在最高电平上
            send(2'(k), ref_lev(2'(k), 3));           // 恰在中间电平上
            // 紧贴两电平中点的两侧 (真中点多半不是 Q4.12 整数)
            send(2'(k), 16'((int'(ref_lev(2'(k),3)) + int'(ref_lev(2'(k),4))) / 2));
            send(2'(k), 16'((int'(ref_lev(2'(k),3)) + int'(ref_lev(2'(k),4))) / 2 + 1));
            send(2'(k), 16'sd32767);                  // 冲出星座外 (正)
            send(2'(k), -16'sd32768);                 // 冲出星座外 (负)
            nsent = nsent + 8;
        end
        repeat (20) @(posedge i_clk);
        chk(nmis == 0, $sformatf("T2 边界 %0d 点对参考模型 0 容差 (失配 %0d)", nsent, nmis));

        //---- T1 三档随机 ----
        nmis = 0;
        for (k = 0; k < 512; k = k + 1)
            send(2'($urandom % 3), 16'($urandom));
        repeat (20) @(posedge i_clk);
        chk(nmis == 0, $sformatf("T1/T4 随机 512 点 0 容差 + 嵌套 Gray 推论 (失配 %0d)", nmis));

        chk(nout == nsent + 512 + 1,
            $sformatf("T3b o_valid 与 i_valid 一一对应: 送 %0d 出 %0d",
                      nsent + 512 + 1, nout));

        $display("");
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_demap_metric (%0d 条未过)", fails);
            $fatal(1, "tb_demap_metric: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_demap_metric");
        $finish;
    end

endmodule

`default_nettype wire
