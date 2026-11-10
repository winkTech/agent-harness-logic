//==============================================================================
// tb_eq_recip — eq_recip (均衡器倒数核) 的判据 TB
//
// **本 TB 写在 eq_recip.sv 之前**, 判据只能来自规格 —— models/comm/ofdm/src/
// rtl_mirror_eq.m 的第 3-6 步 (归一化 / 查表 / Newton), 不可能是照 RTL 描的。
//
// 最强的一条是 T3: TB 内用 SystemVerilog 整数**独立重算**一遍 r1/sh, 与 DUT 逐位
// 比对。同公式、不同语言的交叉实现, 比只看误差上界强 —— 误差上界只能发现"算得不准",
// 发现不了"算得不对但恰好在界内"。同时也查重构关系 1/|H|² = r1·2^(16-sh) 的相对误差,
// 那一条防的是我和 DUT 对规格有**同一个**误解。
//
// ROM 内容 eq_recip_lut.hex 由 rtl_mirror_eq 的 info.lut 导出, DUT 与本 TB 读同一份
// —— 表本身就是规格的一部分, 不该有两个版本。
//
// 运行: 从 rtl/ 目录跑 (hex 用相对路径)
//   iverilog -g2012 -o tb_eq_recip.out ../tb/tb_eq_recip.sv eq_recip.sv && vvp tb_eq_recip.out
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_eq_recip;

    // ri_ (红线1) -> 归一化 -> 查表 -> Newton p/t -> Newton r1 -> ro_ (红线2) = 6 级
    localparam int LAT = 6;                       // i_valid -> o_valid 的固定拍数

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic        i_valid = 1'b0;
    logic [31:0] i_h2    = 32'd0;
    wire         o_valid;
    wire  [15:0] o_r1;
    wire  [5:0]  o_sh;
    wire         o_zero;

    eq_recip dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(i_valid), .i_h2(i_h2),
        .o_valid(o_valid), .o_r1(o_r1), .o_sh(o_sh), .o_zero(o_zero));

    //--------------------------------------------------------------------------
    // 参考实现: 与规格同公式, 本 TB 独立写一遍
    //--------------------------------------------------------------------------
    logic [15:0] ref_lut [0:255];
    initial $readmemh("eq_recip_lut.hex", ref_lut);

    task automatic ref_recip(input logic [31:0] h2,
                             output logic [15:0] r1,
                             output logic [5:0]  sh,
                             output logic        zero);
        int          lz;
        logic [30:0] norm;
        logic [15:0] m16, r0, p, t;
        logic [31:0] mr, rt;
        begin
            zero = (h2 == 32'd0);
            lz   = 32;
            // 低位向高位扫, 后写覆盖先写 -> 留下最高置位 (不用 break: iverilog 不支持)
            for (int b = 0; b < 32; b++) if (h2[b]) lz = 31 - b;
            if (lz == 0) norm = h2[31:1];              // s = -1, 唯一需右移的情形
            else         norm = 31'(h2 << (lz - 1));
            m16 = norm[30:15];
            sh  = 6'(34 - lz);
            r0  = ref_lut[m16[14:7]];
            mr  = m16 * r0;
            p   = mr[31:16];
            t   = 16'h8000 - p;
            rt  = r0 * t;
            r1  = rt[29:14];
        end
    endtask

    //--------------------------------------------------------------------------
    // 记分板: 输入按序入队, 输出逐个核对 (兼查"不串位")
    //--------------------------------------------------------------------------
    logic [31:0] q_h2  [$];
    int fails = 0, checked = 0;
    real max_rel = 0.0;

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    always @(posedge i_clk) begin
        if (!i_rst && i_valid) q_h2.push_back(i_h2);
    end

    logic [15:0] e_r1; logic [5:0] e_sh; logic e_zero;
    logic [31:0] h2_exp;
    real recon, exact, rel;

    always @(posedge i_clk) begin
        if (!i_rst && o_valid) begin
            if (q_h2.size() == 0) begin
                fails++; $display("  [FAIL] o_valid 多出一拍, 队列已空 (串位)");
            end else begin
                h2_exp = q_h2.pop_front();
                ref_recip(h2_exp, e_r1, e_sh, e_zero);
                checked++;
                if (o_zero !== e_zero) begin
                    fails++; $display("  [FAIL] h2=%0d o_zero=%b 期望 %b", h2_exp, o_zero, e_zero);
                end
                if (!e_zero) begin
                    if (o_r1 !== e_r1 || o_sh !== e_sh) begin
                        fails++;
                        $display("  [FAIL] h2=%0d r1=%0d/%0d sh=%0d/%0d (得/期望)",
                                 h2_exp, o_r1, e_r1, o_sh, e_sh);
                    end
                    // 重构关系里的 |H|² 是**真实值** = h2_raw / 2^28 (Q4.28),
                    // 不是原始码值。首版本漏了这个 2^28, 误差恰好差 2.68e8 倍。
                    recon = real'(o_r1) * $pow(2.0, real'(16 - int'(o_sh)));
                    exact = $pow(2.0, 28.0) / real'(h2_exp);
                    rel   = (recon > exact) ? (recon - exact) / exact : (exact - recon) / exact;
                    if (rel > max_rel) max_rel = rel;
                end
            end
        end
    end

    //--------------------------------------------------------------------------
    task automatic push(input logic [31:0] h2, input bit v);
        @(negedge i_clk);
        i_valid = v; i_h2 = h2;
    endtask

    int lat_meas;

    int lut_bad;

    initial begin
        repeat (4) @(negedge i_clk);

        //---- T0 DUT 的 ROM 必须与镜像导出的 hex 逐项相同 ----
        // DUT 按闭式在综合期生成 ROM (为了不依赖外部文件), hex 则是 rtl_mirror_eq 的
        // info.lut 权威导出。两者是两条独立路径, 断言它们逐项相等 —— 一旦哪天闭式被
        // 改动或镜像换了表, 立刻在这里红, 而不是悄悄分家到 cosim 才暴露。
        lut_bad = 0;
        for (int a = 0; a < 256; a++)
            if (dut.w_lut[a] !== ref_lut[a]) begin
                if (lut_bad < 3)
                    $display("  [LUT] a=%0d DUT %0d 镜像 %0d", a, dut.w_lut[a], ref_lut[a]);
                lut_bad++;
            end
        chk(lut_bad == 0, $sformatf("T0 ROM 闭式 == 镜像导出 hex (256 项, 失配 %0d)", lut_bad));

        //---- T5a 复位期间 o_valid 必须为 0 ----
        chk(o_valid === 1'b0, "T5a 复位期间 o_valid 为 0");

        i_rst = 1'b0;
        @(negedge i_clk);

        //---- T4 延迟: 单点打一拍, 数到 o_valid ----
        push(32'h1000_0000, 1'b1);                 // |H|²=1
        push(32'd0, 1'b0);
        lat_meas = 0;
        while (!o_valid && lat_meas < 32) begin
            @(posedge i_clk); lat_meas++;
        end
        chk(lat_meas == LAT, $sformatf("T4 延迟 = %0d 拍 (规格 %0d)", lat_meas, LAT));

        //---- T1 标定: h2 = 2^28 -> sh=31, r1=32767 (闭式) ----
        chk(o_sh === 6'd31 && o_r1 === 16'd32767,
            $sformatf("T1 标定 h2=2^28: sh=%0d r1=%0d (期望 31 / 32767)", o_sh, o_r1));

        repeat (8) @(negedge i_clk);

        //---- T2 归一化两端 ----
        push(32'h8000_0000, 1'b1);                 // 2^31, lz=0, 唯一右移
        push(32'd1,         1'b1);                 // 1,    lz=31, 最大左移
        push(32'd0,         1'b0);
        repeat (LAT + 4) @(negedge i_clk);

        //---- T3 扫描: 覆盖各个八度, 满吞吐 ----
        for (int e = 0; e <= 31; e++) begin
            for (int k = 0; k < 40; k++) begin
                logic [31:0] v;
                v = 32'd1 << e;
                if (e > 0) v = v | (32'($urandom) & ((32'd1 << e) - 1));
                if (v == 0) v = 32'd1;
                if (v > 32'h8000_0000) v = 32'h8000_0000;
                push(v, 1'b1);
            end
        end
        push(32'd0, 1'b0);
        repeat (LAT + 4) @(negedge i_clk);

        //---- T4b 稀疏 valid: 随机插空, 查不串位 ----
        for (int k = 0; k < 300; k++) begin
            if (($urandom % 3) == 0) push(32'd0, 1'b0);
            else                     push(32'((32'($urandom) % 32'h8000_0000) + 1), 1'b1);
        end
        push(32'd0, 1'b0);
        repeat (LAT + 4) @(negedge i_clk);

        //---- T6 除零: 只判精确零 ----
        push(32'd0,         1'b1);
        push(32'd1,         1'b1);
        push(32'h8000_0000, 1'b1);
        push(32'd0,         1'b0);
        repeat (LAT + 4) @(negedge i_clk);

        //---- T5b 复位后重入必须正确 ----
        i_rst = 1'b1;
        repeat (3) @(negedge i_clk);
        q_h2.delete();
        chk(o_valid === 1'b0, "T5b 复位后 o_valid 归 0");
        i_rst = 1'b0;
        @(negedge i_clk);
        for (int k = 0; k < 50; k++) push(32'((32'($urandom) % 32'h8000_0000) + 1), 1'b1);
        push(32'd0, 1'b0);
        repeat (LAT + 4) @(negedge i_clk);

        //---- 汇总 ----
        $display("");
        $display("CHECKED %0d", checked);
        $display("MAX_REL %.3e", max_rel);
        chk(checked > 1500, $sformatf("T3 核对点数 %0d (>1500)", checked));
        chk(q_h2.size() == 0, $sformatf("T3b 队列排空 (残留 %0d)", q_h2.size()));
        // 界取 1.5e-4 而不是分析报告里的 3.8e-6: 那个数是**算法误差** (表项按无限精度
        // 存、Newton 在浮点里做), 而 r1 是 Q2.14 的 16 位数, 自身 1 个 LSB 就是
        // 1/r1 ∈ [3.05e-5, 6.10e-5] 的相对分辨率 —— 那是存储精度的地板, 任何实现都
        // 越不过去。实测 7.3e-5 ≈ 1.2 个 r1 LSB, 正常。界仍足够紧: 移位或定标写错会
        // 差出几个数量级, 不可能藏在 1.5e-4 里。
        chk(max_rel < 1.5e-4, $sformatf("T3c 重构相对误差 %.3e < 1.5e-4 (r1 的 Q2.14 地板 ~6e-5)", max_rel));

        $display("");
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_eq_recip (%0d 条未过)", fails);
            $fatal(1, "tb_eq_recip: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_eq_recip");
        $finish;
    end

endmodule

`default_nettype wire
