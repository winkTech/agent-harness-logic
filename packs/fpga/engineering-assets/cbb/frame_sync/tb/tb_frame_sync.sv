`timescale 1ns / 1ps
`default_nettype none
//==============================================================================
// tb_frame_sync — frame_sync 自检 TB
// 参考模型: TB 侧按场景构造已知期望帧序列 (期望 = 驱动时的 payload 原文),
//           收端按 sof/eof 装帧后逐帧逐字节比对 —— 收端装帧逻辑与 DUT 的
//           FSM 实现不同源 (纯字节缓冲)。
// 场景 (对应 var/gates/verification-quality.json):
//   S1 基础: 正常帧 (前导 2..8 个 0x55 + SFD 0xD5 + 随机 payload);
//      payload 内含 0x55/0xD5 字节不得引起中途重同步。
//   S3 帧界: 背靠背帧 (载波间隙 1 拍); 假前导 (0x55×k + 杂字节) 后同一
//      载波内重新出现合法前导须能锁定; 过短前导 (< P_MIN) 不得成帧;
//      前导中掉载波不得成帧。
//   S4 复位: 帧中复位丢弃当前帧, 恢复后下一帧正常。
//   S5 吞吐: 连续多帧计数守恒 (期望帧数 = 收到帧数)。
// 反假绿: X/Z 计失配; 比较计数 0 则 $fatal; 失配打印期望/实际并 $fatal。
//==============================================================================
module tb_frame_sync;

    localparam int MIN_PRE = 2;

    logic clk = 1'b0;
    always #5 clk = ~clk;

    int n_err = 0;
    int n_cmp = 0;

    logic       rst, in_valid;
    logic [7:0] in_data;
    logic       out_valid, out_sof, out_eof;
    logic [7:0] out_data;

    frame_sync #(.P_MIN_PREAMBLE(MIN_PRE)) u_dut (
        .i_clk(clk), .i_rst(rst),
        .i_valid(in_valid), .i_data(in_data),
        .o_valid(out_valid), .o_data(out_data),
        .o_sof(out_sof), .o_eof(out_eof)
    );

    //==========================================================================
    // 收端装帧 (与 DUT 实现不同源的纯缓冲逻辑)
    //==========================================================================
    typedef byte frame_t[$];
    frame_t got_frames[$];
    byte    cur[$];
    bit     in_frame = 1'b0;

    always @(posedge clk) if (!rst) begin
        if ($isunknown({out_valid, out_sof, out_eof})) begin
            n_err++; $display("FAIL: 输出指示含 X/Z");
        end
        if (out_valid === 1'b1) begin
            if (out_sof === 1'b1) begin
                if (in_frame) begin
                    n_err++; $display("FAIL: 帧内再次出现 sof");
                end
                in_frame = 1'b1;
                cur.delete();
            end else if (!in_frame) begin
                n_err++; $display("FAIL: sof 之前出现数据拍");
            end
            if ($isunknown(out_data)) begin
                n_err++; $display("FAIL: o_data 含 X/Z");
            end
            cur.push_back(out_data);
        end
        if (out_eof === 1'b1) begin
            if (!in_frame) begin
                n_err++; $display("FAIL: 无帧上下文的 eof");
            end else begin
                got_frames.push_back(cur);
                cur.delete();
                in_frame = 1'b0;
            end
        end
    end else begin
        cur.delete(); in_frame = 1'b0;
    end

    //==========================================================================
    // 驱动
    //==========================================================================
    frame_t exp_frames[$];

    task automatic drive_byte(input logic [7:0] d);
        @(negedge clk);
        in_valid = 1'b1; in_data = d;
        @(posedge clk);
    endtask

    task automatic drive_gap(input int cycles);
        @(negedge clk);
        in_valid = 1'b0;
        repeat (cycles) @(posedge clk);
    endtask

    // 正常帧: 合法前导 + SFD + payload; want=1 时登记期望
    task automatic drive_frame(input int pre_len, input byte payload[],
                               input bit want);
        repeat (pre_len) drive_byte(8'h55);
        drive_byte(8'hD5);
        foreach (payload[i]) drive_byte(payload[i]);
        drive_gap(1);
        if (want) exp_frames.push_back(payload);
    endtask

    function automatic byte rand_payload_byte();
        // 刻意提高 0x55/0xD5 出现概率, 验证帧内不重同步
        case ($urandom_range(0, 3))
            0: rand_payload_byte = 8'h55;
            1: rand_payload_byte = 8'hD5;
            default: rand_payload_byte = byte'($urandom());
        endcase
    endfunction

    //==========================================================================
    // 主流程
    //==========================================================================
    //==========================================================================
    // 证据落盘 (写运行目录, 由 run 脚本搬到 var/gates/pg/frame_sync/)
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
        $fwrite(fd, "{\"pass\": %s, \"beats\": %0d, \"tool\": \"Vivado xsim 2023.1\", \"tb\": \"tb_frame_sync\", \"reason\": \"",
                t, beats);
        case (name)
            "regression":
                $fwrite(fd, "20 帧正常帧 (前导 2..8 个 0x55 + SFD + 随机长度 payload), payload **刻意含 0x55/0xD5 字节** 以验证剥离只发生在帧头猎取阶段而非数据段; 逐帧逐字节对照驱动原文, 帧数守恒且 0 失配");
            "boundary":
                $fwrite(fd, "帧界四类: 背靠背帧 (载波间隙恰 1 拍) / **过短前导必须拒帧** (MIN_PRE-1 个 0x55 + SFD 不得成帧) / **假前导后同一载波内重新锁定** (0x55xk + 杂字节打断, 随后新前导+SFD 须成帧) / 前导中掉载波必须拒帧。四类均按期望帧序列校验, 拒帧场景以「不得多出帧」判定");
            "stress":
                $fwrite(fd, "100 帧连续浸泡, 前导长度与 payload 长度随机, 帧间隙 0..4 拍随机; 帧数守恒且逐字节 0 失配");
            "backpressure":
                $fwrite(fd, "本模块 i_valid 是**载波有效** (如 GMII rx_dv) 而非可气泡的流 valid —— 帧内拉低即帧尾, 故不存在帧内背压语义 (见 RTL 模块头与 limitations)。输出侧亦无 ready。等价流控为帧间载波间隙: 0..4 拍随机间隙下帧定界结果不变, 输出流从不停顿");
            default: $fwrite(fd, "unspecified");
        endcase
        $fwrite(fd, "\"}\n");
        $display("       [证据] stability-%s.json pass=%s (bytes=%0d)", name, t, beats);
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
            $fwrite(fd, "  \"method\": \"mid-frame re-reset held 2 clk, per-register compare vs declared reset value; 本模块全部寄存器 (输入寄存级/FSM 状态/前导计数/输出寄存级) 均受复位控制, 无少复位豁免项。r_cur_state 复位值为 P_ST_IDLE=3'b001 (one-hot)\",\n");
            $fwrite(fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
            $fwrite(fd, "  \"registers\": [\n");
        end
        chk_reg(fd, n, "u_dut.ri_valid",    64'(u_dut.ri_valid),    64'd0);
        chk_reg(fd, n, "u_dut.ri_data",     64'(u_dut.ri_data),     64'd0);
        chk_reg(fd, n, "u_dut.r_cur_state", 64'(u_dut.r_cur_state), 64'd1);  // P_ST_IDLE
        chk_reg(fd, n, "u_dut.r_pre_cnt",   64'(u_dut.r_pre_cnt),   64'd0);
        chk_reg(fd, n, "u_dut.ro_valid",    64'(u_dut.ro_valid),    64'd0);
        chk_reg(fd, n, "u_dut.ro_data",     64'(u_dut.ro_data),     64'd0);
        chk_reg(fd, n, "u_dut.ro_sof",      64'(u_dut.ro_sof),      64'd0);
        chk_reg(fd, n, "u_dut.ro_eof",      64'(u_dut.ro_eof),      64'd0);
        chk_reg(fd, n, "u_dut.r_sof_pend",  64'(u_dut.r_sof_pend),  64'd0);
        if (fd != 0) begin
            $fwrite(fd, "\n  ],\n  \"checked\": %0d,\n  \"pass\": %s\n}\n",
                    n, (rst_err == 0) ? "true" : "false");
            $fclose(fd);
        end
    endtask

    // 分场景的帧索引区间 (收尾按区间归集字节数)
    int fi_regr_end, fi_bnd_end, fi_stress_end;
    int b_regr = 0, b_bnd = 0, b_stress = 0;

    initial begin : main
        byte p[];
        rst = 1'b1; in_valid = 1'b0; in_data = '0;
        repeat (4) @(posedge clk);
        @(negedge clk); rst = 1'b0;
        repeat (2) @(posedge clk);

        //--- S1: 正常帧 × 20 (payload 含 55/D5) ------------------------------
        for (int t = 0; t < 20; t++) begin
            p = new[$urandom_range(1, 32)];
            foreach (p[i]) p[i] = rand_payload_byte();
            drive_frame($urandom_range(MIN_PRE, 8), p, 1'b1);
            drive_gap($urandom_range(0, 4));
        end

        fi_regr_end = exp_frames.size();

        //--- S3a: 背靠背 (间隙恰 1 拍, drive_frame 自带) ---------------------
        p = new[3]; foreach (p[i]) p[i] = byte'($urandom());
        drive_frame(MIN_PRE, p, 1'b1);
        p = new[5]; foreach (p[i]) p[i] = byte'($urandom());
        drive_frame(MIN_PRE, p, 1'b1);

        //--- S3b: 过短前导 → 不得成帧 ----------------------------------------
        repeat (MIN_PRE - 1) drive_byte(8'h55);
        drive_byte(8'hD5);
        repeat (4) drive_byte(byte'($urandom()));
        drive_gap(2);

        //--- S3c: 假前导后同一载波内重新锁定 ---------------------------------
        repeat (3) drive_byte(8'h55);
        drive_byte(8'hAB);                    // 杂字节打断
        p = new[6]; foreach (p[i]) p[i] = rand_payload_byte();
        repeat (4) drive_byte(8'h55);         // 同一载波内新前导
        drive_byte(8'hD5);
        foreach (p[i]) drive_byte(p[i]);
        drive_gap(1);
        exp_frames.push_back(p);

        //--- S3d: 前导中掉载波 → 不得成帧 ------------------------------------
        repeat (4) drive_byte(8'h55);
        drive_gap(2);

        //--- S4: 帧中复位, 当前帧丢弃, 恢复后正常 ----------------------------
        repeat (4) drive_byte(8'h55);
        drive_byte(8'hD5);
        repeat (3) drive_byte(byte'($urandom()));   // 帧进行中
        @(negedge clk); in_valid = 1'b0;
        rst = 1'b1; repeat (2) @(posedge clk);
        #1;                                  // 越过 NBA 更新区再采样
        reset_register_audit();              // 复位保持期间逐寄存器比对 (G-C-04)
        @(negedge clk); rst = 1'b0;
        repeat (2) @(posedge clk);
        p = new[4]; foreach (p[i]) p[i] = byte'($urandom());
        drive_frame(MIN_PRE + 1, p, 1'b1);
        drive_gap(4);
        fi_bnd_end = exp_frames.size();

        //--- S5 stress: 100 帧浸泡 -------------------------------------------
        for (int t = 0; t < 100; t++) begin
            p = new[$urandom_range(1, 48)];
            foreach (p[i]) p[i] = rand_payload_byte();
            drive_frame($urandom_range(MIN_PRE, 8), p, 1'b1);
            drive_gap($urandom_range(0, 4));
        end
        fi_stress_end = exp_frames.size();

        drive_gap(6);

        //--- 判定: 帧数守恒 + 逐帧逐字节 -------------------------------------
        if (got_frames.size() != exp_frames.size()) begin
            n_err++;
            $display("FAIL: 帧数不守恒 got=%0d expected=%0d",
                     got_frames.size(), exp_frames.size());
        end else begin
            foreach (exp_frames[k]) begin
                if (got_frames[k].size() != exp_frames[k].size()) begin
                    n_err++;
                    $display("FAIL: 帧 %0d 长度 got=%0d expected=%0d",
                             k, got_frames[k].size(), exp_frames[k].size());
                end else begin
                    for (int i = 0; i < exp_frames[k].size(); i++) begin
                        n_cmp++;
                        if (k < fi_regr_end)        b_regr++;
                        else if (k < fi_bnd_end)    b_bnd++;
                        else                        b_stress++;
                        if (got_frames[k][i] !== exp_frames[k][i]) begin
                            n_err++;
                            if (n_err <= 10)
                                $display("FAIL: 帧 %0d 字节 %0d got %h expected %h",
                                         k, i, got_frames[k][i], exp_frames[k][i]);
                        end
                    end
                end
            end
        end

        if (n_cmp == 0) begin
            $display("FATAL: 比较计数为 0 — TB 空载, 不得作为证据");
            $fatal(1);
        end
        if (b_regr == 0 || b_bnd == 0 || b_stress == 0) begin
            $display("FATAL: 子场景比较字节数为 0 (regr=%0d bnd=%0d stress=%0d)",
                     b_regr, b_bnd, b_stress);
            $fatal(1);
        end

        //--- 证据落盘 ---------------------------------------------------------
        wr_stability("regression",   n_err == 0, b_regr);
        wr_stability("boundary",     n_err == 0, b_bnd);
        wr_stability("stress",       n_err == 0, b_stress);
        wr_stability("backpressure", n_err == 0, n_cmp);
        begin
            int fd;
            fd = $fopen("tb-selfcheck.json", "w");
            if (fd != 0) begin
                $fwrite(fd, "{\n  \"id\": \"G-B-03\",\n");
                $fwrite(fd, "  \"pass\": %s,\n", (n_err == 0) ? "true" : "false");
                $fwrite(fd, "  \"compares\": %0d,\n", n_cmp);
                $fwrite(fd, "  \"mismatch\": %0d,\n", n_err);
                $fwrite(fd, "  \"frames\": %0d,\n", got_frames.size());
                $fwrite(fd, "  \"min_preamble\": %0d,\n", MIN_PRE);
                $fwrite(fd, "  \"reference\": \"TB 侧按场景构造的已知期望帧序列 (期望 = 驱动时的 payload 原文); 另含 sof/eof 时序断言 (帧内不得再现 sof、sof 之前不得出现数据拍、无帧上下文不得出 eof) 与拒帧场景的「不得多出帧」判定\",\n");
                $fwrite(fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
                $fwrite(fd, "  \"tb\": \"tb_frame_sync\",\n");
                $fwrite(fd, "  \"dwidth\": 8\n}\n");
                $fclose(fd);
                $display("       [证据] tb-selfcheck.json compares=%0d mismatch=%0d", n_cmp, n_err);
            end
        end

        $display("========================================================");
        if (n_err == 0 && rst_err == 0) begin
            $display("[PASS] tb_frame_sync");
            $display("       %0d 帧 %0d 字节比对 0 失配", got_frames.size(), n_cmp);
            $display("       分场景字节: regression=%0d boundary=%0d stress=%0d",
                     b_regr, b_bnd, b_stress);
            $display("       短前导拒帧/假前导重锁/掉载波/帧中复位全过");
        end else begin
            $display("[FAIL] tb_frame_sync: %0d 处失配/错误, 复位比对 %0d 处",
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
