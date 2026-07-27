`timescale 1ns / 1ps
`default_nettype none
//==============================================================================
// tb_delay_line — delay_line 自检 TB
// 场景 (对应 var/gates/verification-quality.json):
//   S1 基础: 随机数据/随机 valid 气泡, 对照 TB 内建队列参考模型逐拍比对
//      (P_DELAY=2 最小配置与 P_DELAY=7 两个例化)。
//   S4 复位: 运行中再复位, 复位后 P_DELAY 拍内 o_valid 必须为 0 (无残留),
//      之后恢复正常且不出复位前的旧数据。
//   S5 吞吐: valid 恒高连续流, 输入拍数 = 输出拍数 (计数守恒), 且延迟
//      恰为 P_DELAY 拍 (首字入到首字出实测)。
// 反假绿: X/Z 计失配; 比较计数为 0 直接 $fatal; 失配打印期望/实际并 $fatal。
//==============================================================================
module tb_delay_line;

    localparam int W = 32;

    logic clk = 1'b0;
    always #5 clk = ~clk;   // 100 MHz

    int n_err = 0;

    //==========================================================================
    // 可复用校验器: 每个 DUT 一份 (队列参考模型)
    //==========================================================================
    // DUT A: P_DELAY = 2 (最小)
    localparam int DLY_A = 2;
    logic          rst_a, vin_a, vout_a;
    logic [W-1:0]  din_a, dout_a;

    delay_line #(.P_DWIDTH(W), .P_DELAY(DLY_A)) u_dut_a (
        .i_clk(clk), .i_rst(rst_a),
        .i_valid(vin_a), .i_data(din_a),
        .o_valid(vout_a), .o_data(dout_a)
    );

    // DUT B: P_DELAY = 7
    localparam int DLY_B = 7;
    logic          rst_b, vin_b, vout_b;
    logic [W-1:0]  din_b, dout_b;

    delay_line #(.P_DWIDTH(W), .P_DELAY(DLY_B)) u_dut_b (
        .i_clk(clk), .i_rst(rst_b),
        .i_valid(vin_b), .i_data(din_b),
        .o_valid(vout_b), .o_data(dout_b)
    );

    //==========================================================================
    // 参考模型: 每拍压入采样的 {valid,data}, 满 P_DELAY 拍后弹出比对。
    // 复位时清空队列 (对应 DUT valid 链清零)。
    //==========================================================================
    typedef struct { logic v; logic [W-1:0] d; } beat_t;

    beat_t q_a[$], q_b[$];
    int n_cmp_a = 0, n_cmp_b = 0;
    int n_vin_a = 0, n_vout_a = 0;
    int n_vin_b = 0, n_vout_b = 0;

    task automatic check(input string tag, input int dly,
                         ref beat_t q[$],
                         input logic rst, input logic vin, input logic [W-1:0] din,
                         input logic vout, input logic [W-1:0] dout,
                         ref int n_cmp, ref int n_vin, ref int n_vout);
        beat_t exp;
        if (rst) begin
            // 复位丢弃在途 beat 是契约行为: 把尚未比对的在途 valid 从输入
            // 计数中扣除, 守恒判据只约束"复位外"的数据不丢不重
            foreach (q[k]) if (q[k].v) n_vin--;
            q.delete();
        end else begin
            // 先比对 (当拍输出对应 dly 拍前的输入)
            if (q.size() >= dly) begin
                exp = q.pop_front();
                n_cmp++;
                if ($isunknown(vout) || vout !== exp.v) begin
                    n_err++;
                    if (n_err <= 10)
                        $display("FAIL[%s]: 第 %0d 拍 o_valid got %b expected %b",
                                 tag, n_cmp, vout, exp.v);
                end else if (exp.v && (dout !== exp.d)) begin
                    n_err++;
                    if (n_err <= 10)
                        $display("FAIL[%s]: 第 %0d 拍 o_data got %h expected %h",
                                 tag, n_cmp, dout, exp.d);
                end
            end else if (vout === 1'b1) begin
                n_err++;
                $display("FAIL[%s]: 灌满前 o_valid 提前置位", tag);
            end
            // 再压入当拍输入
            q.push_back('{v: vin, d: din});
            if (vin)  n_vin++;
            if (vout === 1'b1) n_vout++;
        end
    endtask

    always @(posedge clk)
        check("A", DLY_A, q_a, rst_a, vin_a, din_a, vout_a, dout_a,
              n_cmp_a, n_vin_a, n_vout_a);
    always @(posedge clk)
        check("B", DLY_B, q_b, rst_b, vin_b, din_b, vout_b, dout_b,
              n_cmp_b, n_vin_b, n_vout_b);

    //==========================================================================
    // 激励 (两个 DUT 同一套驱动流程, 各自独立随机)
    //==========================================================================
    task automatic drive_random(output logic v, output logic [W-1:0] d,
                                input int pct);
        v = ($urandom_range(0, 99) < pct);
        d = $urandom();
    endtask

    initial begin : main
        rst_a = 1'b1; vin_a = 1'b0; din_a = '0;
        rst_b = 1'b1; vin_b = 1'b0; din_b = '0;
        repeat (4) @(posedge clk);
        @(negedge clk);
        rst_a = 1'b0; rst_b = 1'b0;

        //--- S1: 随机气泡流 ---------------------------------------------------
        repeat (3000) begin
            @(negedge clk);
            drive_random(vin_a, din_a, 65);
            drive_random(vin_b, din_b, 65);
        end

        //--- S5: 连续满流 -----------------------------------------------------
        repeat (1000) begin
            @(negedge clk);
            vin_a = 1'b1; din_a = $urandom();
            vin_b = 1'b1; din_b = $urandom();
        end
        @(negedge clk); vin_a = 1'b0; vin_b = 1'b0;
        repeat (16) @(posedge clk);   // 排空

        //--- S4: 运行中复位 → 残留检查 → 恢复 --------------------------------
        // 先灌数, 复位瞬间链上必有在途数据
        repeat (10) begin
            @(negedge clk);
            vin_a = 1'b1; din_a = $urandom();
            vin_b = 1'b1; din_b = $urandom();
        end
        @(negedge clk);
        vin_a = 1'b0; vin_b = 1'b0;
        rst_a = 1'b1; rst_b = 1'b1;
        repeat (2) @(posedge clk);
        @(negedge clk);
        rst_a = 1'b0; rst_b = 1'b0;
        // 复位释放后 P_DELAY 拍内 o_valid 必须为 0
        begin : post_reset_quiet
            int k;
            for (k = 0; k < DLY_B; k++) begin
                @(posedge clk);
                if (vout_a !== 1'b0 && k < DLY_A) begin
                    n_err++;
                    $display("FAIL[A]: 复位后第 %0d 拍 o_valid 残留", k);
                end
                if (vout_b !== 1'b0) begin
                    n_err++;
                    $display("FAIL[B]: 复位后第 %0d 拍 o_valid 残留", k);
                end
            end
        end
        // 恢复正常流
        repeat (500) begin
            @(negedge clk);
            drive_random(vin_a, din_a, 70);
            drive_random(vin_b, din_b, 70);
        end
        @(negedge clk); vin_a = 1'b0; vin_b = 1'b0;
        repeat (16) @(posedge clk);

        //--- 判定 -------------------------------------------------------------
        if (n_cmp_a == 0 || n_cmp_b == 0) begin
            $display("FATAL: 比较计数为 0 — TB 空载, 不得作为证据");
            $fatal(1);
        end
        if (n_vin_a != n_vout_a) begin
            n_err++;
            $display("FAIL[A]: 计数不守恒 in=%0d out=%0d", n_vin_a, n_vout_a);
        end
        if (n_vin_b != n_vout_b) begin
            n_err++;
            $display("FAIL[B]: 计数不守恒 in=%0d out=%0d", n_vin_b, n_vout_b);
        end

        $display("========================================================");
        if (n_err == 0) begin
            $display("[PASS] tb_delay_line");
            $display("       A(P_DELAY=%0d): %0d 拍比对 0 失配, %0d beats 守恒",
                     DLY_A, n_cmp_a, n_vin_a);
            $display("       B(P_DELAY=%0d): %0d 拍比对 0 失配, %0d beats 守恒",
                     DLY_B, n_cmp_b, n_vin_b);
            $display("       复位后无 valid 残留, 恢复正常");
        end else begin
            $display("[FAIL] tb_delay_line: %0d 处失配/错误", n_err);
            $fatal(1);
        end
        $display("========================================================");
        $finish;
    end

    initial begin
        #10ms;
        $display("FATAL: TB 看门狗超时");
        $fatal(1);
    end

endmodule
`default_nettype wire
