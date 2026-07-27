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
        @(negedge clk); rst = 1'b0;
        repeat (2) @(posedge clk);
        p = new[4]; foreach (p[i]) p[i] = byte'($urandom());
        drive_frame(MIN_PRE + 1, p, 1'b1);

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
        $display("========================================================");
        if (n_err == 0) begin
            $display("[PASS] tb_frame_sync");
            $display("       %0d 帧 %0d 字节比对 0 失配", got_frames.size(), n_cmp);
            $display("       短前导拒帧/假前导重锁/掉载波/帧中复位全过");
        end else begin
            $display("[FAIL] tb_frame_sync: %0d 处失配/错误", n_err);
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
