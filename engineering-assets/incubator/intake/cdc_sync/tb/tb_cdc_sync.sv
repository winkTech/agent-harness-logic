`timescale 1ns / 1ps
`default_nettype none
//==============================================================================
// tb_cdc_sync — cdc_sync 自检 TB
// 场景 (对应 var/gates/verification-quality.json):
//   S1 基础: 多比特握手双向异频 (A: src 7.3ns → dst 10ns; B: src 10ns →
//      dst 7.3ns, 非整数倍频比), 随机数据序列经发端 scoreboard 队列逐字
//      比对 —— 0 丢 0 重 0 乱序 0 X; o_valid_dst 必须为单拍脉冲;
//      o_ready_src=0 期间输入被拒不丢重 (由计数守恒隐含覆盖)。
//      单比特电平同步 (C): 慢速电平序列 dst 侧转变序列与 src 侧一致。
//   S4 复位: 两域联合复位后重新收发, 恢复正常 (部分域复位不在契约内)。
//   S5 吞吐: 连续 300 字计数守恒 (吞吐受握手往返约束, 判据不丢不重)。
// 反假绿: 内建参考 = 发端队列; X/Z 计失配; 比较计数 0 则 $fatal。
//==============================================================================
module tb_cdc_sync;

    localparam int W = 8;
    localparam int STAGES = 2;

    int n_err = 0;

    //==========================================================================
    // 时钟: 7.3ns 与 10ns
    //==========================================================================
    logic clk_f = 1'b0;   // 快钟
    logic clk_s = 1'b0;   // 慢钟
    always #3.65 clk_f = ~clk_f;
    always #5    clk_s = ~clk_s;

    //==========================================================================
    // DUT A: 快 → 慢
    //==========================================================================
    logic          rst_src_a, rst_dst_a;
    logic          vin_a, rdy_a, vout_a;
    logic [W-1:0]  din_a, dout_a;

    cdc_sync #(.P_DWIDTH(W), .P_STAGES(STAGES)) u_dut_a (
        .i_clk_src(clk_f), .i_rst_src(rst_src_a),
        .i_valid_src(vin_a), .i_data_src(din_a), .o_ready_src(rdy_a),
        .i_clk_dst(clk_s), .i_rst_dst(rst_dst_a),
        .o_valid_dst(vout_a), .o_data_dst(dout_a)
    );

    //==========================================================================
    // DUT B: 慢 → 快
    //==========================================================================
    logic          rst_src_b, rst_dst_b;
    logic          vin_b, rdy_b, vout_b;
    logic [W-1:0]  din_b, dout_b;

    cdc_sync #(.P_DWIDTH(W), .P_STAGES(STAGES)) u_dut_b (
        .i_clk_src(clk_s), .i_rst_src(rst_src_b),
        .i_valid_src(vin_b), .i_data_src(din_b), .o_ready_src(rdy_b),
        .i_clk_dst(clk_f), .i_rst_dst(rst_dst_b),
        .o_valid_dst(vout_b), .o_data_dst(dout_b)
    );

    //==========================================================================
    // DUT C: 单比特电平, 快 → 慢
    //==========================================================================
    logic rst_src_c, rst_dst_c;
    logic lvl_c, rdy_c, vout_c, dout_c;

    cdc_sync #(.P_DWIDTH(1), .P_STAGES(STAGES)) u_dut_c (
        .i_clk_src(clk_f), .i_rst_src(rst_src_c),
        .i_valid_src(1'b1), .i_data_src(lvl_c), .o_ready_src(rdy_c),
        .i_clk_dst(clk_s), .i_rst_dst(rst_dst_c),
        .o_valid_dst(vout_c), .o_data_dst(dout_c)
    );

    //==========================================================================
    // 多比特 scoreboard (发端队列 = 参考模型)
    //==========================================================================
    logic [W-1:0] q_a[$], q_b[$];
    int n_sent_a = 0, n_recv_a = 0, n_cmp = 0;
    int n_sent_b = 0, n_recv_b = 0;
    logic prev_vout_a = 1'b0, prev_vout_b = 1'b0;

    // 发端: 在 src 时钟采样成交
    always @(posedge clk_f) if (!rst_src_a && vin_a && rdy_a) begin
        q_a.push_back(din_a);
        n_sent_a++;
    end
    always @(posedge clk_s) if (!rst_src_b && vin_b && rdy_b) begin
        q_b.push_back(din_b);
        n_sent_b++;
    end

    // 收端: dst 时钟检查
    task automatic recv_check(input string tag,
                              ref logic [W-1:0] q[$],
                              input logic vout, input logic [W-1:0] dout,
                              ref int n_recv, ref logic prev_v);
        logic [W-1:0] exp;
        if (vout === 1'b1) begin
            if (prev_v === 1'b1) begin
                n_err++;
                $display("FAIL[%s]: o_valid_dst 连续多拍 (非单拍脉冲)", tag);
            end
            n_recv++;
            if (q.size() == 0) begin
                n_err++;
                $display("FAIL[%s]: 收到未发送的字 (重复/伪造)", tag);
            end else begin
                exp = q.pop_front();
                n_cmp++;
                if ($isunknown(dout) || dout !== exp) begin
                    n_err++;
                    if (n_err <= 10)
                        $display("FAIL[%s]: 第 %0d 字 got %h expected %h",
                                 tag, n_recv, dout, exp);
                end
            end
        end else if ($isunknown(vout)) begin
            n_err++;
            $display("FAIL[%s]: o_valid_dst 为 X/Z", tag);
        end
        prev_v = vout;
    endtask

    always @(posedge clk_s) if (!rst_dst_a)
        recv_check("A", q_a, vout_a, dout_a, n_recv_a, prev_vout_a);
    always @(posedge clk_f) if (!rst_dst_b)
        recv_check("B", q_b, vout_b, dout_b, n_recv_b, prev_vout_b);

    //==========================================================================
    // 单比特电平序列记录 (去除连续重复后的转变序列必须一致)
    //==========================================================================
    logic src_seq_c[$], dst_seq_c[$];
    logic src_last_c = 1'bx, dst_last_c = 1'bx;
    bit   rec_en_c = 1'b0;   // main 在电平稳定后初始化 last 值再开闸

    always @(posedge clk_f) if (!rst_src_c && rec_en_c) begin
        if (lvl_c !== src_last_c) begin
            src_seq_c.push_back(lvl_c);
            src_last_c = lvl_c;
        end
    end
    always @(posedge clk_s) if (!rst_dst_c && rec_en_c) begin
        if ($isunknown(dout_c)) begin
            n_err++;
            $display("FAIL[C]: 输出电平 X/Z");
        end else if (dout_c !== dst_last_c) begin
            dst_seq_c.push_back(dout_c);
            dst_last_c = dout_c;
        end
    end

    //==========================================================================
    // 发端驱动任务: 发送 n 个随机字 (等待 ready, 随机间隙)
    //==========================================================================
    task automatic send_words_a(input int n);
        repeat (n) begin
            @(negedge clk_f);
            vin_a = 1'b1; din_a = $urandom();
            do @(posedge clk_f); while (!(vin_a && rdy_a));
            @(negedge clk_f);
            vin_a = 1'b0;
            repeat ($urandom_range(0, 3)) @(negedge clk_f);
        end
    endtask

    task automatic send_words_b(input int n);
        repeat (n) begin
            @(negedge clk_s);
            vin_b = 1'b1; din_b = $urandom();
            do @(posedge clk_s); while (!(vin_b && rdy_b));
            @(negedge clk_s);
            vin_b = 1'b0;
            repeat ($urandom_range(0, 3)) @(negedge clk_s);
        end
    endtask

    task automatic reset_all();
        rst_src_a = 1'b1; rst_dst_a = 1'b1;
        rst_src_b = 1'b1; rst_dst_b = 1'b1;
        repeat (5) @(posedge clk_s);
        @(negedge clk_f); rst_src_a = 1'b0; rst_src_b = 1'b0;
        @(negedge clk_s); rst_dst_a = 1'b0; rst_dst_b = 1'b0;
        repeat (4) @(posedge clk_s);
    endtask

    //==========================================================================
    // 主流程
    //==========================================================================
    bit done_a = 1'b0, done_b = 1'b0;

    initial begin : drv_a
        vin_a = 1'b0; din_a = '0;
        wait (rst_src_a === 1'b0);
        repeat (2) @(posedge clk_f);
        send_words_a(200);            // S1
        wait (done_b);                 // 等 B 完成后联合复位 (S4)
        wait (rst_src_a === 1'b1);    // 必须先看到 S4 复位置位, 再等释放
        wait (rst_src_a === 1'b0 && rst_dst_a === 1'b0);
        repeat (4) @(posedge clk_f);
        send_words_a(300);            // S5 连续
        done_a = 1'b1;
    end

    initial begin : drv_b
        vin_b = 1'b0; din_b = '0;
        wait (rst_src_b === 1'b0);
        repeat (2) @(posedge clk_s);
        send_words_b(200);            // S1
        done_b = 1'b1;
    end

    initial begin : main
        rst_src_c = 1'b1; rst_dst_c = 1'b1; lvl_c = 1'b0;
        reset_all();

        // 等 S1 双向完成
        wait (done_b);
        // 排空 A 在途
        #2000;

        //--- S4: 联合复位 (清 scoreboard, 在途丢弃属契约行为) ---------------
        // 在途字从发送计数中扣除, 守恒判据只约束复位外的数据不丢不重
        n_sent_a -= q_a.size(); n_sent_b -= q_b.size();
        q_a.delete(); q_b.delete();
        reset_all();
        prev_vout_a = 1'b0; prev_vout_b = 1'b0;

        // S5 由 drv_a 继续发 300 字
        wait (done_a);
        #4000;   // 排空

        //--- 单比特电平: 20 次慢速翻转 ---------------------------------------
        rst_src_c = 1'b0; rst_dst_c = 1'b0;
        repeat (8) @(posedge clk_s);           // 让同步链稳定输出当前电平
        src_seq_c.delete(); dst_seq_c.delete();
        src_last_c = lvl_c; dst_last_c = dout_c;   // 以实际电平初始化
        @(negedge clk_s);
        rec_en_c = 1'b1;
        repeat (20) begin
            @(negedge clk_f);
            lvl_c = ~lvl_c;
            repeat (8) @(posedge clk_s);   // 每级电平保持 ≥8 慢拍
        end
        repeat (8) @(posedge clk_s);
        // 序列比对
        if (dst_seq_c.size() != src_seq_c.size()) begin
            n_err++;
            $display("FAIL[C]: 转变数不一致 src=%0d dst=%0d",
                     src_seq_c.size(), dst_seq_c.size());
        end else begin
            foreach (src_seq_c[k]) begin
                n_cmp++;
                if (dst_seq_c[k] !== src_seq_c[k]) begin
                    n_err++;
                    $display("FAIL[C]: 第 %0d 次转变 got %b expected %b",
                             k, dst_seq_c[k], src_seq_c[k]);
                end
            end
        end

        //--- 判定 -------------------------------------------------------------
        if (n_cmp == 0) begin
            $display("FATAL: 比较计数为 0 — TB 空载, 不得作为证据");
            $fatal(1);
        end
        if (n_sent_a != n_recv_a) begin
            n_err++;
            $display("FAIL[A]: 计数不守恒 sent=%0d recv=%0d", n_sent_a, n_recv_a);
        end
        if (n_sent_b != n_recv_b) begin
            n_err++;
            $display("FAIL[B]: 计数不守恒 sent=%0d recv=%0d", n_sent_b, n_recv_b);
        end

        $display("========================================================");
        if (n_err == 0) begin
            $display("[PASS] tb_cdc_sync");
            $display("       A 快→慢: %0d 字 0 丢 0 重 0 失配", n_recv_a);
            $display("       B 慢→快: %0d 字 0 丢 0 重 0 失配", n_recv_b);
            $display("       C 电平:  %0d 次转变全部到达且有序", dst_seq_c.size());
            $display("       联合复位后恢复正常; valid 均为单拍脉冲");
        end else begin
            $display("[FAIL] tb_cdc_sync: %0d 处失配/错误", n_err);
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
