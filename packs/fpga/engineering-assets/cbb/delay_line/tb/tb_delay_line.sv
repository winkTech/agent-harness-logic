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

    //==========================================================================
    // 证据落盘 (写运行目录, 由 run 脚本搬到 var/gates/pg/delay_line/)
    // reason 直写格式串: xsim 的 $fwrite 用 %s 输出多字节 string 会损坏内容
    //==========================================================================
    int rst_err = 0;

    function automatic void wr_stability(input string name, input bit ok,
                                         input int beats);
        int fd;
        string t;
        t = ok ? "true" : "false";
        fd = $fopen({"stability-", name, ".json"}, "w");
        if (fd == 0) begin
            $display("FAIL: 无法写 stability-%s.json", name);
            return;
        end
        $fwrite(fd, "{\"pass\": %s, \"beats\": %0d, \"tool\": \"Vivado xsim 2023.1\", \"tb\": \"tb_delay_line\", \"reason\": \"",
                t, beats);
        case (name)
            "regression":
                $fwrite(fd, "随机气泡流下逐拍对照 TB 内建期望队列 (独立于 RTL 的移位链实现), o_valid 与 o_data 均逐拍相等; 灌满前 o_valid 不得提前置位");
            "boundary":
                $fwrite(fd, "参数边界: P_DELAY=2 (模块允许的最小值, 此时中间链为空、输入寄存直连输出寄存) 与 P_DELAY=7 (含 5 级中间链) 两个例化并行验证; 另含复位释放后 P_DELAY 拍内 o_valid 必须为 0 的静默窗口检查");
            "stress":
                $fwrite(fd, "1000 拍连续满流 (valid 恒高) 后拉低排空, 逐拍比对 0 失配且排空后无残留输出");
            "backpressure":
                $fwrite(fd, "本原语无 tready 反压接口 (定长延迟与背压是正交职责, 背压由 axis_skid_buffer 承担, 见 RTL 模块头裁决)。等价流控为 i_valid 气泡: 全程 o_valid 拍数严格等于 i_valid 拍数 (计数守恒不丢不重), 且延迟恒为 P_DELAY 拍与气泡图样无关");
            default: $fwrite(fd, "unspecified");
        endcase
        $fwrite(fd, "\"}\n");
        $display("       [证据] stability-%s.json pass=%s (beats=%0d)", name, t, beats);
    endfunction

    task automatic chk_reg(input int fd, inout int n, input string nm,
                           input logic [63:0] got, input logic [63:0] want);
        if (fd != 0) begin
            if (n > 0) $fwrite(fd, ",\n");
            $fwrite(fd, "    {\"reg\":\"%s\",\"got\":\"0x%h\",\"want\":\"0x%h\",\"pass\":%s}",
                    nm, got, want, (got === want) ? "true" : "false");
        end
        n++;
        if (got !== want) begin
            rst_err++;
            $display("FAIL: 复位比对 %s got=%h want=%h", nm, got, want);
        end
    endtask

    task automatic reset_register_audit();
        int fd, n;
        rst_err = 0; n = 0;
        fd = $fopen("reset-sim.json", "w");
        if (fd != 0) begin
            $fwrite(fd, "{\n  \"id\": \"G-C-04.reset\",\n");
            $fwrite(fd, "  \"method\": \"mid-stream re-reset held 2 clk, per-register compare vs declared reset value. **数据链 (ri_data / r_data_pipe / ro_data) 刻意不复位** —— 这是本模块的显式设计决策 (RTL 模块头): 数据由 valid 门控, 不复位可省复位扇出并让综合器推断 SRL 移位寄存器; 故复位审计只覆盖 valid 链, 数据链按 hdl 规范 §1.1/§10.2 豁免, 其正确性由复位释放后的静默窗口检查与计数守恒承担\",\n");
            $fwrite(fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
            $fwrite(fd, "  \"registers\": [\n");
        end
        chk_reg(fd, n, "u_dut_a.ri_valid", 64'(u_dut_a.ri_valid), 64'd0);
        chk_reg(fd, n, "u_dut_a.ro_valid", 64'(u_dut_a.ro_valid), 64'd0);
        chk_reg(fd, n, "u_dut_b.ri_valid", 64'(u_dut_b.ri_valid), 64'd0);
        chk_reg(fd, n, "u_dut_b.ro_valid", 64'(u_dut_b.ro_valid), 64'd0);
        for (int k = 0; k < DLY_B - 2; k++)
            chk_reg(fd, n, $sformatf("u_dut_b.gen_chain.r_valid_pipe[%0d]", k),
                    64'(u_dut_b.gen_chain.r_valid_pipe[k]), 64'd0);
        if (fd != 0) begin
            $fwrite(fd, "\n  ],\n  \"checked\": %0d,\n  \"pass\": %s\n}\n",
                    n, (rst_err == 0) ? "true" : "false");
            $fclose(fd);
        end
    endtask

    int c_regr, c_stress, c_bnd, c_mark;

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

        c_regr = n_cmp_a + n_cmp_b;

        //--- S5: 连续满流 -----------------------------------------------------
        c_mark = n_cmp_a + n_cmp_b;
        repeat (1000) begin
            @(negedge clk);
            vin_a = 1'b1; din_a = $urandom();
            vin_b = 1'b1; din_b = $urandom();
        end
        @(negedge clk); vin_a = 1'b0; vin_b = 1'b0;
        repeat (16) @(posedge clk);   // 排空
        c_stress = (n_cmp_a + n_cmp_b) - c_mark;

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
        #1;                                  // 越过 NBA 更新区再采样
        reset_register_audit();              // 复位保持期间逐寄存器比对 (G-C-04)
        @(negedge clk);
        rst_a = 1'b0; rst_b = 1'b0;
        // 复位释放后 P_DELAY 拍内 o_valid 必须为 0
        c_mark = n_cmp_a + n_cmp_b;
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
        c_bnd = (n_cmp_a + n_cmp_b) - c_mark;   // 复位静默窗口 + 恢复流

        //--- 判定 -------------------------------------------------------------
        if (n_cmp_a == 0 || n_cmp_b == 0) begin
            $display("FATAL: 比较计数为 0 — TB 空载, 不得作为证据");
            $fatal(1);
        end
        if (c_regr == 0 || c_stress == 0 || c_bnd == 0) begin
            $display("FATAL: 子场景比较数为 0 (regr=%0d stress=%0d bnd=%0d)",
                     c_regr, c_stress, c_bnd);
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

        //--- 证据落盘 ---------------------------------------------------------
        wr_stability("regression",   n_err == 0, c_regr);
        wr_stability("boundary",     n_err == 0, c_bnd);
        wr_stability("stress",       n_err == 0, c_stress);
        wr_stability("backpressure", n_err == 0 && n_vin_a == n_vout_a
                                     && n_vin_b == n_vout_b, n_vin_a + n_vin_b);
        begin
            int fd;
            fd = $fopen("tb-selfcheck.json", "w");
            if (fd != 0) begin
                $fwrite(fd, "{\n  \"id\": \"G-B-03\",\n");
                $fwrite(fd, "  \"pass\": %s,\n", (n_err == 0) ? "true" : "false");
                $fwrite(fd, "  \"compares\": %0d,\n", n_cmp_a + n_cmp_b);
                $fwrite(fd, "  \"mismatch\": %0d,\n", n_err);
                $fwrite(fd, "  \"beats_in\": %0d,\n", n_vin_a + n_vin_b);
                $fwrite(fd, "  \"beats_out\": %0d,\n", n_vout_a + n_vout_b);
                $fwrite(fd, "  \"delays_tested\": [%0d, %0d],\n", DLY_A, DLY_B);
                $fwrite(fd, "  \"reference\": \"TB 内建期望队列 (按 P_DELAY 拍精确延迟的软件模型, 独立于 RTL 的移位链实现); 另检灌满前 o_valid 不得提前置位\",\n");
                $fwrite(fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
                $fwrite(fd, "  \"tb\": \"tb_delay_line\",\n");
                $fwrite(fd, "  \"dwidth\": %0d\n}\n", W);
                $fclose(fd);
                $display("       [证据] tb-selfcheck.json compares=%0d mismatch=%0d",
                         n_cmp_a + n_cmp_b, n_err);
            end
        end

        $display("========================================================");
        if (n_err == 0 && rst_err == 0) begin
            $display("[PASS] tb_delay_line");
            $display("       分场景: regression=%0d stress=%0d boundary=%0d",
                     c_regr, c_stress, c_bnd);
            $display("       A(P_DELAY=%0d): %0d 拍比对 0 失配, %0d beats 守恒",
                     DLY_A, n_cmp_a, n_vin_a);
            $display("       B(P_DELAY=%0d): %0d 拍比对 0 失配, %0d beats 守恒",
                     DLY_B, n_cmp_b, n_vin_b);
            $display("       复位后无 valid 残留, 恢复正常");
        end else begin
            $display("[FAIL] tb_delay_line: %0d 处失配/错误, 复位比对 %0d 处",
                     n_err, rst_err);
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
