//==============================================================================
// tb_fft64_sdf — 顶层封装集成测试 (core + reorder)
//
// 本 TB 只验**接线与输出序**, 数值正确性由 tb_fft64_sdf_core / tb_fft64_direction
// 承担, 位真由 cosim 承担。判据仍全部解析可知:
//   1. P_NATURAL_OUT=1 送直流: 输出**按流序**第 0 点即为峰值 16384, 其余近 0。
//      —— 这直接证明 core 的位反序输出被 reorder 正确还原, 无需 TB 侧做 bitrev。
//   2. P_NATURAL_OUT=0 送直流: 输出为位反序流, 峰值落在 o_idx 使 bitrev(o_idx)==0
//      的那一拍 (即 o_idx==0)。两种配置的差异必须真实存在。
//   3. 侧带在两种配置下都必须与本符号首个输出同拍。
//   4. 复位后无残留 valid。
//
// 反假绿: 任一判据失败即 $fatal(1)。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_sdf;

    localparam int DATA_W = 16;
    localparam int AMP    = 2048;      // 8*AMP = 16384 (Q2.14 不饱和)
    localparam int PEAK   = 8 * AMP;
    localparam int TOL    = 8;

    logic i_clk = 1'b0, i_rst = 1'b1, i_beat = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;

    logic n_valid, n_sb, b_valid, b_sb;
    logic [5:0] n_idx, b_idx;
    logic signed [DATA_W-1:0] n_re, n_im, b_re, b_im;

    int errors = 0;
    // 自然序实例: 按**流序**记录
    int nat_seq [0:63];
    int nat_c = 0;
    int nat_sb_pos = -1;
    // 位反序实例: 记录峰值出现时的 o_idx
    int brv_peak_idx = -1;
    int brv_sb_idx   = -1;

    always #5 i_clk = ~i_clk;

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b1)) dut_nat (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(n_valid), .o_idx(n_idx), .o_re(n_re), .o_im(n_im), .o_sb(n_sb));

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b0)) dut_brv (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(b_valid), .o_idx(b_idx), .o_re(b_re), .o_im(b_im), .o_sb(b_sb));

    task automatic check(input string what, input bit cond);
        if (!cond) begin
            $display("  [FAIL] %s", what);
            errors = errors + 1;
        end
    endtask

    // 自然序: 以侧带为符号起点, 按流序存
    always @(posedge i_clk) begin
        if (!i_rst) begin
            if (n_valid && n_sb) begin
                nat_seq[0] <= int'(n_re);
                nat_c      <= 1;
                if (nat_sb_pos < 0) nat_sb_pos <= 0;
            end else if (n_valid && nat_c > 0 && nat_c < 64) begin
                nat_seq[nat_c] <= int'(n_re);
                nat_c          <= nat_c + 1;
            end
            // 位反序: 找峰值出现在哪个 o_idx 上; 记侧带那拍的 o_idx
            if (b_valid && int'(b_re) > PEAK/2 && brv_peak_idx < 0) brv_peak_idx <= int'(b_idx);
            if (b_valid && b_sb && brv_sb_idx < 0)                  brv_sb_idx   <= int'(b_idx);
        end
    end

    // flush 必须是 64 的整数倍 (SDF 块边界按有效拍划分)
    task automatic feed_dc(input bit on);
        for (int n = 0; n < 64; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1;
            i_sb    = (n == 0);
            i_re    = on ? DATA_W'(AMP) : '0;
            i_im    = '0;
        end
        for (int n = 0; n < 192; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1; i_sb = 1'b0; i_re = '0; i_im = '0;
        end
    endtask

    initial begin
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        feed_dc(1'b0);          // 预热: 冲掉未初始化的 X
        nat_c = 0;
        feed_dc(1'b1);          // 直流
        repeat (200) @(negedge i_clk);

        // ---- 1. 自然序: 流序第 0 点即峰值 ----
        check($sformatf("自然序: 应收满 64 点, 实收 %0d", nat_c), nat_c == 64);
        check($sformatf("自然序: 流序第 0 点应为 %0d, 实为 %0d", PEAK, nat_seq[0]),
              (nat_seq[0] > PEAK - TOL) && (nat_seq[0] < PEAK + TOL));
        for (int m = 1; m < 64; m++)
            check($sformatf("自然序: 流序第 %0d 点应近 0, 实为 %0d", m, nat_seq[m]),
                  (nat_seq[m] > -TOL) && (nat_seq[m] < TOL));

        // ---- 2. 位反序配置: 峰值落在 o_idx==0 (bitrev(0)==0) ----
        check($sformatf("位反序: 峰值应出现在 o_idx=0, 实为 %0d", brv_peak_idx),
              brv_peak_idx == 0);

        // ---- 3. 侧带在两种配置下都与本符号首个输出同拍 ----
        check($sformatf("自然序: 侧带应落在流序第 0 点, 实为第 %0d", nat_sb_pos),
              nat_sb_pos == 0);
        check($sformatf("位反序: 侧带那拍 o_idx 应为 0, 实为 %0d", brv_sb_idx),
              brv_sb_idx == 0);

        // ---- 4. 复位后无残留 valid ----
        i_rst = 1'b1;
        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        repeat (8) @(negedge i_clk);
        check("复位后自然序 o_valid 应为 0", n_valid == 1'b0);
        check("复位后位反序 o_valid 应为 0", b_valid == 1'b0);

        if (errors == 0) begin
            $display("RESULT: PASS - tb_fft64_sdf, 0 errors (core+reorder 接线与输出序全部通过)");
            $finish;
        end else begin
            $fatal(1, "TB_FAIL: tb_fft64_sdf %0d 项判据失败", errors);
        end
    end

endmodule

`default_nettype wire
