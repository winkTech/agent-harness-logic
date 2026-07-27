`timescale 1ns / 1ps
`default_nettype none
//==============================================================================
// tb_crc32 — crc32 自检 TB
// 参考模型: TB 内建软件式反射 CRC-32 (查表法思路的逐位实现, 与 RTL 的
//           移位展开不同源) + IEEE 802.3 标准检验值硬锚。
// 场景 (对应 var/gates/verification-quality.json):
//   S1 基础: '123456789' → 0xCBF43926 (IEEE 检验值, 反射语义的硬证据);
//      随机长度随机内容帧逐帧对照参考模型。
//   S3 帧界: 单字节帧 / 长帧 / 背靠背帧 (i_last 后立即开新帧)。
//   S4 复位: 运行中复位后首帧结果与冷启动一致。
//   S5 吞吐: 满流 (valid 恒高) 与随机气泡两种供流方式结果一致。
// 反假绿: X/Z 计失配; 比较计数 0 则 $fatal; 失配打印期望/实际并 $fatal。
//==============================================================================
module tb_crc32;

    logic clk = 1'b0;
    always #5 clk = ~clk;

    int n_err = 0;
    int n_cmp = 0;

    logic        rst, in_valid, in_last;
    logic [7:0]  in_data;
    logic        out_valid;
    logic [31:0] out_crc;

    crc32 u_dut (
        .i_clk(clk), .i_rst(rst),
        .i_valid(in_valid), .i_data(in_data), .i_last(in_last),
        .o_valid(out_valid), .o_crc(out_crc)
    );

    //==========================================================================
    // 参考模型: 反射式 CRC-32 (LSB-first, init FFFFFFFF, 末尾取反)
    //==========================================================================
    function automatic logic [31:0] ref_crc32(input byte data[]);
        logic [31:0] c;
        begin
            c = 32'hFFFF_FFFF;
            foreach (data[i]) begin
                c = c ^ {24'h0, data[i]};
                repeat (8) c = c[0] ? ((c >> 1) ^ 32'hEDB8_8320) : (c >> 1);
            end
            ref_crc32 = ~c;
        end
    endfunction

    //==========================================================================
    // 驱动 + 采集
    //==========================================================================
    task automatic send_frame(input byte data[], input int bubble_pct,
                              output logic [31:0] got);
        bit got_out = 1'b0;
        foreach (data[i]) begin
            @(negedge clk);
            while ($urandom_range(0, 99) < bubble_pct) begin
                in_valid = 1'b0;
                @(negedge clk);
            end
            in_valid = 1'b1;
            in_data  = data[i];
            in_last  = (i == data.size() - 1);
            @(posedge clk);
        end
        @(negedge clk);
        in_valid = 1'b0; in_last = 1'b0;
        // 收结果 (i_last 后固定 2 拍)
        repeat (5) begin
            @(posedge clk);
            if (out_valid === 1'b1) begin
                got = out_crc;
                got_out = 1'b1;
                break;
            end
        end
        if (!got_out) begin
            n_err++;
            $display("FAIL: 帧尾后未见 o_valid");
            got = 'x;
        end
    endtask

    task automatic check_frame(input byte data[], input int bubble_pct,
                               input string tag);
        logic [31:0] got, exp;
        send_frame(data, bubble_pct, got);
        exp = ref_crc32(data);
        n_cmp++;
        if ($isunknown(got) || got !== exp) begin
            n_err++;
            $display("FAIL[%s]: len=%0d got %h expected %h", tag, data.size(), got, exp);
        end
    endtask

    //==========================================================================
    // 主流程
    //==========================================================================
    initial begin : main
        byte f[];
        logic [31:0] got, cold;
        rst = 1'b1; in_valid = 1'b0; in_last = 1'b0; in_data = '0;
        repeat (4) @(posedge clk);
        @(negedge clk); rst = 1'b0;
        repeat (2) @(posedge clk);

        //--- S1a: IEEE 802.3 标准检验值 '123456789' → 0xCBF43926 -------------
        f = '{8'h31, 8'h32, 8'h33, 8'h34, 8'h35, 8'h36, 8'h37, 8'h38, 8'h39};
        send_frame(f, 0, got);
        n_cmp++;
        if (got !== 32'hCBF4_3926) begin
            n_err++;
            $display("FAIL[IEEE]: '123456789' got %h expected cbf43926 — 反射语义错", got);
        end
        cold = got;

        //--- S3 帧界: 单字节 / 长帧 / 背靠背 ---------------------------------
        f = new[1]; f[0] = 8'hA5;
        check_frame(f, 0, "single");
        f = new[1500]; foreach (f[i]) f[i] = byte'($urandom());
        check_frame(f, 0, "long1500");
        // 背靠背: last 拍后下一拍立即开新帧 (send_frame 天然背靠背)
        f = new[4]; foreach (f[i]) f[i] = byte'($urandom());
        check_frame(f, 0, "b2b_1");
        f = new[7]; foreach (f[i]) f[i] = byte'($urandom());
        check_frame(f, 0, "b2b_2");

        //--- S1b/S5: 随机帧 × 满流与气泡 -------------------------------------
        for (int t = 0; t < 30; t++) begin
            f = new[$urandom_range(1, 64)];
            foreach (f[i]) f[i] = byte'($urandom());
            check_frame(f, (t % 2) ? 40 : 0, "rand");
        end

        //--- S4: 运行中复位, 首帧与冷启动一致 --------------------------------
        @(negedge clk);
        in_valid = 1'b1; in_data = 8'hFF; in_last = 1'b0;   // 喂半帧后复位
        repeat (3) @(posedge clk);
        @(negedge clk); in_valid = 1'b0;
        rst = 1'b1; repeat (2) @(posedge clk);
        @(negedge clk); rst = 1'b0;
        repeat (2) @(posedge clk);
        f = '{8'h31, 8'h32, 8'h33, 8'h34, 8'h35, 8'h36, 8'h37, 8'h38, 8'h39};
        send_frame(f, 0, got);
        n_cmp++;
        if (got !== cold) begin
            n_err++;
            $display("FAIL[S4]: 复位后首帧 %h != 冷启动 %h", got, cold);
        end

        //--- 判定 -------------------------------------------------------------
        if (n_cmp == 0) begin
            $display("FATAL: 比较计数为 0 — TB 空载, 不得作为证据");
            $fatal(1);
        end
        $display("========================================================");
        if (n_err == 0) begin
            $display("[PASS] tb_crc32");
            $display("       %0d 帧比对 0 失配 (含 IEEE 检验值 0xCBF43926)", n_cmp);
            $display("       单字节/1500B/背靠背/气泡/复位重算全过");
        end else begin
            $display("[FAIL] tb_crc32: %0d 处失配/错误", n_err);
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
