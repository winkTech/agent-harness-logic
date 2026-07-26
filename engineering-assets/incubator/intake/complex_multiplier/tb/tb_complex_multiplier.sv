`timescale 1ns / 1ps
//==============================================================================
// tb_complex_multiplier — complex_multiplier 自检 Testbench
//
// 反假绿约定 (库级 V-1..V-6):
//   - 参考模型直接用 longint 有符号整数算术独立计算 (a_re*b_re - a_im*b_im 等),
//     与 RTL 的分级乘加流水实现完全不同, 不复用 RTL 表达式;
//   - X/Z 显式计为失配 ($isunknown);
//   - 比较计数为 0 时 $fatal (空载即失败);
//   - 消息一律 ASCII。
//
// 特别说明: 本 TB 的参考公式是复数乘法的定义式
//     (a_re + j*a_im) * (b_re + j*b_im) = (a_re*b_re - a_im*b_im)
//                                       + j*(a_re*b_im + a_im*b_re)
//   源模板 templates/comm/cmult.sv 的三乘法实现算错了这个式子
//   (其注释自称 re = ac + bd, 正确应为 ac - bd), 本 TB 以定义式为准。
//
// 检查项:
//   C1 数值正确性: 逐拍对照 longint 参考值 (全精度, 不允许容差)
//   C2 延迟对齐  : o_valid 与 o_re/o_im 同拍, 且相对输入固定 3 拍
//   C3 边界      : 含 ±最大值/±最小值/0/±1 的定向向量, 验证无溢出无符号错误
//   C4 空隙      : i_valid 间断时不得产生多余输出
//   C5 复位      : 复位期间输出为 0/valid=0; 复位后可恢复
//==============================================================================
module tb_complex_multiplier;

    localparam int  P_A_W        = 16;
    localparam int  P_B_W        = 16;
    localparam int  P_OUT_W      = P_A_W + P_B_W + 1;
    localparam int  P_LATENCY    = 3;
    localparam time P_CLK_PERIOD = 10ns;

    //==========================================================================
    // DUT 接口
    //==========================================================================
    logic                       i_clk;
    logic                       i_rst;
    logic                       i_valid;
    logic signed [P_A_W-1:0]    i_a_re;
    logic signed [P_A_W-1:0]    i_a_im;
    logic signed [P_B_W-1:0]    i_b_re;
    logic signed [P_B_W-1:0]    i_b_im;
    logic                       o_valid;
    logic signed [P_OUT_W-1:0]  o_re;
    logic signed [P_OUT_W-1:0]  o_im;

    complex_multiplier #(
        .P_A_W (P_A_W),
        .P_B_W (P_B_W)
    ) u_dut (
        .i_clk   (i_clk),
        .i_rst   (i_rst),
        .i_valid (i_valid),
        .i_a_re  (i_a_re),
        .i_a_im  (i_a_im),
        .i_b_re  (i_b_re),
        .i_b_im  (i_b_im),
        .o_valid (o_valid),
        .o_re    (o_re),
        .o_im    (o_im)
    );

    //==========================================================================
    // 时钟
    //==========================================================================
    initial begin
        i_clk = 1'b0;
        forever #(P_CLK_PERIOD/2) i_clk = ~i_clk;
    end

    //==========================================================================
    // 统计
    //==========================================================================
    int unsigned n_checks   = 0;
    int unsigned n_valid    = 0;   // 有效输出比对次数
    int unsigned n_mismatch = 0;
    string       s_phase    = "init";
    bit          b_active   = 1'b0;

    //==========================================================================
    // 确定性伪随机 (xorshift32)
    //==========================================================================
    logic [31:0] r_rnd = 32'hDEAD_1357;
    function automatic logic [31:0] next_rand();
        r_rnd = r_rnd ^ (r_rnd << 13);
        r_rnd = r_rnd ^ (r_rnd >> 17);
        r_rnd = r_rnd ^ (r_rnd << 5);
        return r_rnd;
    endfunction

    //==========================================================================
    // 参考模型 —— 独立 longint 算术 + 深度 3 的期望流水
    //==========================================================================
    longint exp_re [0:P_LATENCY-1];
    longint exp_im [0:P_LATENCY-1];
    bit     exp_v  [0:P_LATENCY-1];

    always @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < P_LATENCY; k++) begin
                exp_re[k] = 0;
                exp_im[k] = 0;
                exp_v[k]  = 1'b0;
            end
        end else begin
            // 由末端向前移位 (阻塞赋值, 顺序语义)
            for (int k = P_LATENCY-1; k > 0; k--) begin
                exp_re[k] = exp_re[k-1];
                exp_im[k] = exp_im[k-1];
                exp_v[k]  = exp_v[k-1];
            end
            // 复数乘法定义式
            exp_re[0] = longint'(i_a_re) * longint'(i_b_re)
                      - longint'(i_a_im) * longint'(i_b_im);
            exp_im[0] = longint'(i_a_re) * longint'(i_b_im)
                      + longint'(i_a_im) * longint'(i_b_re);
            exp_v[0]  = i_valid;
        end
    end

    //==========================================================================
    // 检查器 (negedge: DUT 与模型均已稳定)
    //==========================================================================
    always @(negedge i_clk) begin
        if (b_active && !i_rst) begin
            n_checks++;

            if (o_valid !== exp_v[P_LATENCY-1]) begin
                n_mismatch++;
                $display("[FAIL] t=%0t phase=%s : o_valid=%b exp=%b",
                         $time, s_phase, o_valid, exp_v[P_LATENCY-1]);
                $fatal(1, "C2 valid misalignment");
            end

            if (exp_v[P_LATENCY-1]) begin
                n_valid++;
                if ($isunknown(o_re) || $isunknown(o_im)) begin
                    n_mismatch++;
                    $display("[FAIL] t=%0t phase=%s : output has X/Z  re=%h im=%h",
                             $time, s_phase, o_re, o_im);
                    $fatal(1, "C1 X/Z on output");
                end
                if (longint'(o_re) !== exp_re[P_LATENCY-1]) begin
                    n_mismatch++;
                    $display("[FAIL] t=%0t phase=%s : o_re got=%0d exp=%0d",
                             $time, s_phase, longint'(o_re), exp_re[P_LATENCY-1]);
                    $fatal(1, "C1 real part mismatch");
                end
                if (longint'(o_im) !== exp_im[P_LATENCY-1]) begin
                    n_mismatch++;
                    $display("[FAIL] t=%0t phase=%s : o_im got=%0d exp=%0d",
                             $time, s_phase, longint'(o_im), exp_im[P_LATENCY-1]);
                    $fatal(1, "C1 imag part mismatch");
                end
            end
        end
    end

    //==========================================================================
    // 激励
    //==========================================================================
    task automatic drive(input bit vld,
                         input logic signed [P_A_W-1:0] are,
                         input logic signed [P_A_W-1:0] aim,
                         input logic signed [P_B_W-1:0] bre,
                         input logic signed [P_B_W-1:0] bim);
        @(negedge i_clk);
        i_valid = vld;
        i_a_re  = are;
        i_a_im  = aim;
        i_b_re  = bre;
        i_b_im  = bim;
    endtask

    localparam logic signed [15:0] C_MAX = 16'sh7FFF;   //  32767
    localparam logic signed [15:0] C_MIN = 16'sh8000;   // -32768

    initial begin
        // ── 复位 ──
        s_phase = "reset";
        i_rst   = 1'b1;
        i_valid = 1'b0;
        i_a_re  = '0;
        i_a_im  = '0;
        i_b_re  = '0;
        i_b_im  = '0;
        repeat (4) @(negedge i_clk);

        if (o_valid !== 1'b0 || o_re !== '0 || o_im !== '0) begin
            $display("[FAIL] during reset: valid=%b re=%h im=%h", o_valid, o_re, o_im);
            $fatal(1, "C5 reset behaviour");
        end

        i_rst = 1'b0;
        @(negedge i_clk);
        b_active = 1'b1;

        // ── C3: 定向边界向量 ──
        s_phase = "C3-boundary";
        drive(1'b1,      0,      0,      0,      0);
        drive(1'b1,      1,      0,      0,      1);   // j
        drive(1'b1,      0,      1,      0,      1);   // -1
        drive(1'b1,  C_MAX,  C_MAX,  C_MAX,  C_MAX);
        drive(1'b1,  C_MIN,  C_MIN,  C_MIN,  C_MIN);
        drive(1'b1,  C_MIN,      0,  C_MIN,      0);   // 2^30
        drive(1'b1,  C_MIN,  C_MAX,  C_MAX,  C_MIN);
        drive(1'b1,  C_MAX,  C_MIN,  C_MIN,  C_MAX);
        drive(1'b1,     -1,     -1,     -1,     -1);
        drive(1'b1,      1,      1,      1,     -1);
        drive(1'b1,  C_MAX,      0,      0,  C_MIN);
        drive(1'b1,      0,  C_MIN,  C_MIN,      0);
        repeat (6) drive(1'b0, 0, 0, 0, 0);

        // ── C1: 随机满流水 ──
        s_phase = "C1-random-fullrate";
        for (int k = 0; k < 2000; k++) begin
            automatic logic [31:0] r0 = next_rand();
            automatic logic [31:0] r1 = next_rand();
            drive(1'b1, r0[15:0], r0[31:16], r1[15:0], r1[31:16]);
        end
        repeat (6) drive(1'b0, 0, 0, 0, 0);

        // ── C4: valid 间断 ──
        s_phase = "C4-valid-gaps";
        for (int k = 0; k < 1000; k++) begin
            automatic logic [31:0] r0 = next_rand();
            automatic logic [31:0] r1 = next_rand();
            drive(r0[0] & r0[5], r0[15:0], r0[31:16], r1[15:0], r1[31:16]);
        end
        repeat (6) drive(1'b0, 0, 0, 0, 0);

        // ── C5: 运行中再复位 ──
        s_phase  = "C5-rereset";
        b_active = 1'b0;
        @(negedge i_clk);
        i_rst   = 1'b1;
        i_valid = 1'b0;
        repeat (3) @(negedge i_clk);
        if (o_valid !== 1'b0 || o_re !== '0 || o_im !== '0) begin
            $display("[FAIL] after re-reset: valid=%b re=%h im=%h", o_valid, o_re, o_im);
            $fatal(1, "C5 re-reset behaviour");
        end
        i_rst = 1'b0;
        @(negedge i_clk);
        b_active = 1'b1;

        s_phase = "C5-resume";
        for (int k = 0; k < 100; k++) begin
            automatic logic [31:0] r0 = next_rand();
            automatic logic [31:0] r1 = next_rand();
            drive(1'b1, r0[15:0], r0[31:16], r1[15:0], r1[31:16]);
        end
        repeat (8) drive(1'b0, 0, 0, 0, 0);

        // ── 收尾判定 ──
        b_active = 1'b0;
        if (n_checks == 0) begin
            $fatal(1, "[FAIL] zero comparisons - testbench ran empty (anti-false-green rule)");
        end
        if (n_valid == 0) begin
            $fatal(1, "[FAIL] no valid output beat was ever compared");
        end
        if (n_mismatch != 0) begin
            $fatal(1, "[FAIL] %0d mismatches", n_mismatch);
        end
        $display("========================================================");
        $display("[PASS] tb_complex_multiplier");
        $display("       cycles compared       = %0d", n_checks);
        $display("       valid beats compared  = %0d (0 mismatch)", n_valid);
        $display("       latency               = %0d cycles", P_LATENCY);
        $display("       P_A_W=%0d P_B_W=%0d P_OUT_W=%0d", P_A_W, P_B_W, P_OUT_W);
        $display("========================================================");
        $finish;
    end

    //==========================================================================
    // 看门狗
    //==========================================================================
    initial begin
        #500us;
        $fatal(1, "[FAIL] simulation timeout");
    end

endmodule
