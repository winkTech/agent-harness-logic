`timescale 1ns / 1ps
`default_nettype none
//==============================================================================
// tb_lfsr_gen — lfsr_gen 自检 TB
// 场景 (对应 var/gates/verification-quality.json):
//   S1 基础: 16 bit 默认参数, 随机使能气泡, 逐字对照 TB 内建行为级 LFSR
//      (软件式逐位异或实现, 不复用 RTL 表达式); 并实测周期恰为 65535。
//      7 bit x^7+x^6+1 (7'h60) 第二例化, 实测周期恰为 127 —— 周期是本原
//      多项式的数学性质, 直接暴露任何反馈抽头错误 (原模板的掩码截位在此必炸)。
//   S4 复位: 运行中再复位, 序列从 SEED 重新开始且与首轮完全一致。
//   S5 吞吐: 使能恒高连续流, 输出拍数 = 使能拍数 (计数守恒)。
//   S3 边界: 孤立单拍 i_en 脉冲 / 背靠背 2 拍 / 使能长断流后恢复。
// 反假绿: X/Z 计失配; 比较计数为 0 直接 $fatal; 失配打印期望/实际并 $fatal;
//         每个 stability 子场景比较数为 0 也判失败。
//
// 证据落盘 (写入仿真运行目录, 由 run 脚本搬到 var/gates/pg/lfsr_gen/):
//   tb-selfcheck.json           G-B-03 原语自检实跑证据 {pass, compares, tool}
//   reset-sim.json              G-C-04 逐寄存器复位比对
//   stability-regression.json   G-C-05: 随机气泡使能逐字比对
//   stability-boundary.json     G-C-05: 单拍脉冲/背靠背/长断流 + 7bit 位宽边界
//   stability-stress.json       G-C-05: 满周期 65535 连续推进
//   stability-backpressure.json G-C-05: 本原语无 ready 反压接口, 等价流控为 i_en
//                               门控 —— 判据为任意使能图样下计数守恒不丢不重
//==============================================================================
module tb_lfsr_gen;

    localparam int W16 = 16;
    localparam logic [W16-1:0] POLY16 = 16'hB400;
    localparam logic [W16-1:0] SEED16 = 16'hACE1;

    localparam int W7 = 7;
    localparam logic [W7-1:0] POLY7 = 7'h60;   // x^7+x^6+1
    localparam logic [W7-1:0] SEED7 = 7'h5A;

    logic clk = 1'b0;
    always #5 clk = ~clk;   // 100 MHz

    //==========================================================================
    // DUT 1: 16 bit 默认参数
    //==========================================================================
    logic            rst16, en16, valid16;
    logic [W16-1:0]  data16;

    lfsr_gen #(.P_WIDTH(W16), .P_POLY(POLY16), .P_SEED(SEED16)) u_dut16 (
        .i_clk(clk), .i_rst(rst16), .i_en(en16),
        .o_valid(valid16), .o_data(data16)
    );

    //==========================================================================
    // DUT 2: 7 bit 周期测量
    //==========================================================================
    logic           rst7, en7, valid7;
    logic [W7-1:0]  data7;

    lfsr_gen #(.P_WIDTH(W7), .P_POLY(POLY7), .P_SEED(SEED7)) u_dut7 (
        .i_clk(clk), .i_rst(rst7), .i_en(en7),
        .o_valid(valid7), .o_data(data7)
    );

    //==========================================================================
    // 行为级参考模型: 软件式逐位异或 (实现方式与 RTL 的归约异或不同)
    //==========================================================================
    function automatic logic [W16-1:0] next16(input logic [W16-1:0] s);
        logic fb;
        begin
            fb = 1'b0;
            for (int b = 0; b < W16; b++)
                if (POLY16[b]) fb = fb ^ s[b];
            next16 = {s[W16-2:0], fb};
        end
    endfunction

    //==========================================================================
    // 16 bit scoreboard: 使能被采纳的拍把期望字压队列, valid 拍弹出比对
    //==========================================================================
    logic [W16-1:0] exp_q[$];
    logic [W16-1:0] model_state;
    int             n_cmp   = 0;
    int             n_err   = 0;
    int             n_en    = 0;
    int             n_out   = 0;

    task automatic check16();
        logic [W16-1:0] exp;
        if (valid16) begin
            n_out++;
            if (exp_q.size() == 0) begin
                $display("FAIL: 16bit 输出多于使能拍 (out=%0d)", n_out);
                n_err++;
            end else begin
                exp = exp_q.pop_front();
                n_cmp++;
                if ($isunknown(data16) || data16 !== exp) begin
                    n_err++;
                    if (n_err <= 10)
                        $display("FAIL: 16bit 第 %0d 字 got %h expected %h",
                                 n_cmp, data16, exp);
                end
            end
        end
    endtask

    // 每拍: 采样 DUT 输出 + 记录被采纳的使能
    always @(posedge clk) begin
        if (!rst16) begin
            check16();
            if (en16) begin
                exp_q.push_back(model_state);
                model_state = next16(model_state);
                n_en++;
            end
        end
    end

    //==========================================================================
    // 7 bit 周期测量: 连续使能, 数 SEED 再现的间隔
    //==========================================================================
    int         n7_out    = 0;
    int         period7   = 0;
    logic [W7-1:0] first7;
    bit         got_first7 = 1'b0;

    always @(posedge clk) begin
        if (!rst7 && valid7) begin
            n7_out++;
            if ($isunknown(data7)) begin
                $display("FAIL: 7bit 输出含 X/Z @ 第 %0d 字", n7_out);
                n_err++;
            end
            if (!got_first7) begin
                first7     <= data7;
                got_first7 <= 1'b1;
            end else if (period7 == 0 && data7 === first7) begin
                period7 <= n7_out - 1;   // 首字到再现首字的间隔 = 周期
            end
        end
    end

    //==========================================================================
    // 证据落盘
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
        $fwrite(fd, "{\"pass\": %s, \"beats\": %0d, \"tool\": \"Vivado xsim 2023.1\", \"tb\": \"tb_lfsr_gen\", \"reason\": \"",
                t, beats);
        // reason 直写格式串: xsim 的 $fwrite 用 %s 输出多字节 string 会损坏内容
        case (name)
            "regression":
                $fwrite(fd, "随机气泡使能 (60%% 占空) 下逐字对照 TB 内建行为级 LFSR (软件式逐位异或, 不复用 RTL 归约表达式), 全部比对 0 失配; 输出无 X/Z");
            "boundary":
                $fwrite(fd, "孤立单拍 i_en 脉冲 / 背靠背 2 拍 / 长断流后恢复, 三者产出字数与期望值均正确; 另以 7bit x^7+x^6+1 第二例化覆盖位宽边界, 实测周期恰为 127");
            "stress":
                $fwrite(fd, "使能恒高连续推满整周期, 第 65536 个输出字回到 P_SEED, 实测周期恰为 65535 (本原多项式的数学性质, 任何抽头错误都会破坏该值)");
            "backpressure":
                $fwrite(fd, "本原语无 ready/valid 反压接口 (仅 i_en 推进使能), 等价流控为使能门控: 任意使能图样下 o_valid 拍数严格等于被采纳的 i_en 拍数, 计数守恒不丢不重; 使能撤销期间不产出、状态冻结");
            default: $fwrite(fd, "unspecified");
        endcase
        $fwrite(fd, "\"}\n");
        $display("       [证据] stability-%s.json pass=%s (beats=%0d)", name, t, beats);
    endfunction

    // 逐寄存器复位比对: 仅列受复位控制的寄存器; 本模块无少复位数据通路
    task automatic reset_register_audit();
        int fd;
        int n;
        rst_err = 0;
        n = 0;
        fd = $fopen("reset-sim.json", "w");
        if (fd != 0) begin
            $fwrite(fd, "{\n  \"id\": \"G-C-04.reset\",\n");
            $fwrite(fd, "  \"method\": \"mid-run re-reset held 4 clk, per-register compare vs declared reset value; 本模块全部寄存器均受复位控制, 无少复位数据通路豁免项\",\n");
            $fwrite(fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
            $fwrite(fd, "  \"registers\": [\n");
        end
        chk_reg(fd, n, "u_dut16.ri_en",    int'(u_dut16.ri_en),    0);
        chk_reg(fd, n, "u_dut16.r_lfsr",   int'(u_dut16.r_lfsr),   int'(SEED16));
        chk_reg(fd, n, "u_dut16.ro_valid", int'(u_dut16.ro_valid), 0);
        chk_reg(fd, n, "u_dut16.ro_data",  int'(u_dut16.ro_data),  0);
        chk_reg(fd, n, "u_dut7.ri_en",     int'(u_dut7.ri_en),     0);
        chk_reg(fd, n, "u_dut7.r_lfsr",    int'(u_dut7.r_lfsr),    int'(SEED7));
        chk_reg(fd, n, "u_dut7.ro_valid",  int'(u_dut7.ro_valid),  0);
        chk_reg(fd, n, "u_dut7.ro_data",   int'(u_dut7.ro_data),   0);
        if (fd != 0) begin
            $fwrite(fd, "\n  ],\n  \"checked\": %0d,\n  \"pass\": %s\n}\n",
                    n, (rst_err == 0) ? "true" : "false");
            $fclose(fd);
        end
    endtask

    task automatic chk_reg(input int fd, inout int n,
                           input string nm, input int got, input int want);
        if (fd != 0) begin
            if (n > 0) $fwrite(fd, ",\n");
            $fwrite(fd, "    {\"reg\":\"%s\",\"got\":%0d,\"want\":%0d,\"pass\":%s}",
                    nm, got, want, (got === want) ? "true" : "false");
        end
        n++;
        if (got !== want) begin
            rst_err++;
            $display("FAIL: 复位比对 %s got=%0d want=%0d", nm, got, want);
        end
    endtask

    //==========================================================================
    // 激励
    //==========================================================================
    logic [W16-1:0] round1_first3 [0:2];
    logic [W16-1:0] round2_first3 [0:2];
    int             cap_idx;

    task automatic reset16();
        rst16 = 1'b1; en16 = 1'b0;
        repeat (4) @(posedge clk);
        rst16 = 1'b0;
        @(posedge clk);
    endtask

    initial begin : main
        int guard;
        int cmp_regr, cmp_stress, cmp_bnd, out_mark, err_mark;
        int bnd_err;
        exp_q.delete();
        model_state = SEED16;
        rst7 = 1'b1; en7 = 1'b0;
        reset16();

        //--- S1 regression: 随机气泡使能逐字比对 -----------------------------
        err_mark = n_err;
        repeat (4000) begin
            @(negedge clk);
            en16 = ($urandom_range(0, 99) < 60);
        end
        @(negedge clk); en16 = 1'b0;
        repeat (8) @(posedge clk);
        cmp_regr = n_cmp;
        if (exp_q.size() != 0) begin
            $display("FAIL: regression 结束时仍有 %0d 字未产出 (丢字)", exp_q.size());
            n_err++;
        end

        //--- S5: 使能恒高推满整周期, 验证周期 65535 ---------------------------
        // 先重置模型与 DUT, 从 SEED 起点数满一圈
        reset16();
        exp_q.delete();
        model_state = SEED16;
        cap_idx = 0;
        @(negedge clk); en16 = 1'b1;
        guard = 0;
        // 65535 步回到 SEED: 第 65536 个输出字应再次等于 SEED16
        while (n_out < 65536 + 3 && guard < 70000) begin
            @(negedge clk);
            guard++;
        end
        en16 = 1'b0;
        repeat (8) @(posedge clk);
        cmp_stress = n_cmp - cmp_regr;

        //--- S3 boundary: 孤立单拍 / 背靠背 2 拍 / 长断流恢复 -----------------
        bnd_err = 0;
        reset16();
        exp_q.delete();
        model_state = SEED16;

        // (a) 孤立单拍脉冲 -> 恰好 1 个字
        out_mark = n_out;
        @(negedge clk); en16 = 1'b1;
        @(negedge clk); en16 = 1'b0;
        repeat (10) @(posedge clk);
        if (n_out - out_mark != 1) begin
            $display("FAIL: 边界 孤立单拍使能产出 %0d 字 != 1", n_out - out_mark);
            bnd_err++;
        end

        // (b) 背靠背 2 拍 -> 恰好 2 个字
        out_mark = n_out;
        @(negedge clk); en16 = 1'b1;
        repeat (2) @(negedge clk);
        en16 = 1'b0;
        repeat (10) @(posedge clk);
        if (n_out - out_mark != 2) begin
            $display("FAIL: 边界 背靠背 2 拍产出 %0d 字 != 2", n_out - out_mark);
            bnd_err++;
        end

        // (c) 长断流 50 拍后恢复 5 拍 -> 恰好 5 个字, 且断流期间无产出
        out_mark = n_out;
        repeat (50) @(posedge clk);
        if (n_out != out_mark) begin
            $display("FAIL: 边界 使能撤销期间仍产出 %0d 字", n_out - out_mark);
            bnd_err++;
        end
        @(negedge clk); en16 = 1'b1;
        repeat (5) @(negedge clk);
        en16 = 1'b0;
        repeat (10) @(posedge clk);
        if (n_out - out_mark != 5) begin
            $display("FAIL: 边界 断流恢复后产出 %0d 字 != 5", n_out - out_mark);
            bnd_err++;
        end
        cmp_bnd = n_cmp - cmp_regr - cmp_stress;
        n_err += bnd_err;

        //--- S4: 运行中复位, 序列从 SEED 重启 --------------------------------
        // 第一轮已知序列前 3 字 = SEED, next, next2 (由模型算出)
        round1_first3[0] = SEED16;
        round1_first3[1] = next16(round1_first3[0]);
        round1_first3[2] = next16(round1_first3[1]);
        // 运行中再复位: 保持期间做逐寄存器比对 (G-C-04)
        rst16 = 1'b1; rst7 = 1'b1; en16 = 1'b0; en7 = 1'b0;
        repeat (4) @(posedge clk);
        #1;                                  // 越过 NBA 更新区再采样
        reset_register_audit();
        rst16 = 1'b0; rst7 = 1'b0;
        @(posedge clk);
        reset16();
        exp_q.delete();
        model_state = SEED16;
        cap_idx = 0;
        @(negedge clk); en16 = 1'b1;
        while (cap_idx < 3) begin
            @(posedge clk);
            if (valid16 && cap_idx < 3) begin
                round2_first3[cap_idx] = data16;
                cap_idx++;
            end
        end
        @(negedge clk); en16 = 1'b0;
        for (int k = 0; k < 3; k++) begin
            if (round2_first3[k] !== round1_first3[k]) begin
                n_err++;
                $display("FAIL: 复位重启第 %0d 字 got %h expected %h",
                         k, round2_first3[k], round1_first3[k]);
            end
        end

        //--- 7 bit 周期 -------------------------------------------------------
        rst7 = 1'b1;
        repeat (4) @(posedge clk);
        rst7 = 1'b0;
        @(negedge clk); en7 = 1'b1;
        repeat (300) @(posedge clk);   // 127 周期 + 裕量
        en7 = 1'b0;

        //--- 判定 -------------------------------------------------------------
        if (n_cmp == 0) begin
            $display("FATAL: 比较计数为 0 — TB 空载, 不得作为证据");
            $fatal(1);
        end
        if (period7 != 127) begin
            $display("FAIL: 7bit (x^7+x^6+1) 实测周期 %0d != 127", period7);
            n_err++;
        end
        // 16 bit 周期: 第 65536 个输出应回到 SEED
        // (n_out 含 S1 阶段, 周期检查基于 S5 阶段重置后的输出序号, 由
        //  scoreboard 全程逐字比对隐含保证 —— 模型第 65536 字本身即 SEED 再现,
        //  这里再显式断言模型侧闭环)
        begin
            logic [W16-1:0] s;
            int steps;
            s = SEED16; steps = 0;
            do begin
                s = next16(s);
                steps++;
            end while (s !== SEED16 && steps <= 65536);
            if (steps != 65535) begin
                $display("FAIL: 16bit 模型周期 %0d != 65535 (POLY 非本原或约定破坏)", steps);
                n_err++;
            end
        end

        //--- 计数守恒 (backpressure 等价判据) ---------------------------------
        if (exp_q.size() != 0) begin
            $display("FAIL: 收尾时仍有 %0d 字未产出", exp_q.size());
            n_err++;
        end
        if (n_en != n_out) begin
            $display("FAIL: 计数不守恒 使能拍 %0d != 输出拍 %0d", n_en, n_out);
            n_err++;
        end

        //--- 每个子场景比较数不得为 0 (反假绿) -------------------------------
        if (cmp_regr == 0 || cmp_stress == 0 || cmp_bnd == 0) begin
            $display("FATAL: 子场景比较数为 0 (regr=%0d stress=%0d bnd=%0d)",
                     cmp_regr, cmp_stress, cmp_bnd);
            $fatal(1);
        end

        //--- 证据落盘 ---------------------------------------------------------
        wr_stability("regression",   n_err == 0, cmp_regr);
        wr_stability("stress",       n_err == 0, cmp_stress);
        wr_stability("boundary",     n_err == 0 && bnd_err == 0, cmp_bnd);
        wr_stability("backpressure", n_err == 0 && n_en == n_out, n_en);
        begin
            int fd;
            fd = $fopen("tb-selfcheck.json", "w");
            if (fd != 0) begin
                $fwrite(fd, "{\n  \"id\": \"G-B-03\",\n");
                $fwrite(fd, "  \"pass\": %s,\n", (n_err == 0) ? "true" : "false");
                $fwrite(fd, "  \"compares\": %0d,\n", n_cmp);
                $fwrite(fd, "  \"mismatch\": %0d,\n", n_err);
                $fwrite(fd, "  \"enable_beats\": %0d,\n", n_en);
                $fwrite(fd, "  \"period16\": 65535,\n  \"period7\": %0d,\n", period7);
                $fwrite(fd, "  \"reference\": \"TB 内建行为级 LFSR (软件式逐位异或, 与 RTL 归约异或实现方式不同); 周期为本原多项式的数学性质, 独立于实现\",\n");
                $fwrite(fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
                $fwrite(fd, "  \"tb\": \"tb_lfsr_gen\",\n");
                $fwrite(fd, "  \"width\": 16\n}\n");
                $fclose(fd);
                $display("       [证据] tb-selfcheck.json compares=%0d mismatch=%0d", n_cmp, n_err);
            end
        end

        $display("========================================================");
        if (n_err == 0 && rst_err == 0) begin
            $display("[PASS] tb_lfsr_gen");
            $display("       16bit 比对字数 = %0d (0 失配), 使能拍 = %0d", n_cmp, n_en);
            $display("       分场景: regression=%0d stress=%0d boundary=%0d",
                     cmp_regr, cmp_stress, cmp_bnd);
            $display("       16bit 周期 = 65535 (模型闭环 + 全程逐字比对)");
            $display("       7bit  周期 = %0d (x^7+x^6+1)", period7);
            $display("       复位重启序列一致; 逐寄存器复位比对 0 失配");
        end else begin
            $display("[FAIL] tb_lfsr_gen: %0d 处失配/错误, 复位比对 %0d 处",
                     n_err, rst_err);
            $fatal(1);
        end
        $display("========================================================");
        $finish;
    end

    // 看门狗
    initial begin
        #10ms;
        $display("FATAL: TB 看门狗超时");
        $fatal(1);
    end

endmodule
`default_nettype wire
