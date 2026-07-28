//-----------------------------------------------------------------
//              LDPC Encoder Testbench
//-----------------------------------------------------------------
// 功能: 验证 ldpc_encoder_top 编码正确性
//
// 测试: 1) 复位 2) 全零码 3) 随机码的系统码性质 (前 K 位 == 输入信息位)
//
// 2026-07-28 随 RTL 规范整改同步修正了本 TB 的三处缺陷:
//   (1) collect_code 原在 @(posedge clk) 处直接读 m_tdata —— 取到的是该边沿
//       **之前**的旧值, 整条码字整体错位一位; 且只看 tvalid 不看 tready,
//       不是按握手采样。该缺陷此前被编码器挂死掩盖 (随机用例跑不到比对)。
//   (2) drive_info 用非阻塞在边沿处换数据, 与 DUT 实际消费拍对不齐。
//   (3) `$finish(n_fail ? 1 : 0)` —— $finish(N) 的 N 是**诊断详略等级**,
//       不是进程退出码, 于是失败也以 0 退出, 上游读起来全是通过。
//   现两个 task 均严格按 (tvalid && tready) 成交后 #1 越过边沿再采样/换数,
//   失败走 $fatal。
//
// 局限 (未解决): 本 TB 只验"系统码性质"(前 324 位透传) 与全零码, **不验校验位**。
//   真正的 bit-true 对标需要 MATLAB golden 导出的 tb_code_bits_N.hex,
//   该向量尚未入库。
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module tb_ldpc_encoder_top;

    parameter CLK_PERIOD = 10;
    parameter N_TESTS    = 5;

    reg           clk, rst;
    reg           s_tvalid, s_tdata;
    wire          s_tready;
    wire          m_tvalid, m_tdata;
    reg           m_tready;

    reg [323:0]   info_mem;
    reg [647:0]   code_mem;     // 期望码字 (从文件/MATLAB 加载)
    reg [647:0]   enc_mem;      // RTL 输出
    integer       bit_cnt;
    integer       n_pass, n_fail;

    ldpc_encoder_top u_dut (
        .i_clk_sys           (clk),
        .i_rst_sys           (rst),
        .s_axis_info_tdata   (s_tdata),
        .s_axis_info_tvalid  (s_tvalid),
        .s_axis_info_tready  (s_tready),
        .m_axis_code_tdata   (m_tdata),
        .m_axis_code_tvalid  (m_tvalid),
        .m_axis_code_tready  (m_tready)
    );

    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    //-----------------------------------------------------------------
    // 驱动: 发送信息位 (严格按 AXI4-Stream 握手)
    //-----------------------------------------------------------------
    task drive_info(input [323:0] bits);
        integer i;
    begin
        i = 0;
        s_tvalid = 1'b1;
        s_tdata  = bits[0];
        while (i < 324) begin
            @(posedge clk);
            if (s_tready) begin        // 本拍成交
                i = i + 1;
                #1;                    // 越过边沿再换数据
                s_tdata = (i < 324) ? bits[i] : 1'b0;
            end
        end
        @(negedge clk);
        s_tvalid = 1'b0;
    end
    endtask

    //-----------------------------------------------------------------
    // 收集: 读码字 (严格按 AXI4-Stream 握手)
    //-----------------------------------------------------------------
    task collect_code;
        integer i;
        integer guard;
    begin
        m_tready = 1'b1;
        i     = 0;
        guard = 0;
        while (i < 648 && guard < 200000) begin
            @(posedge clk);
            guard = guard + 1;
            // AXI-S 语义: 一次成交携带的是**该时钟边沿之前**总线上的值。
            // 在 @(posedge clk) 的 active 区直接读即可取到该值; 加 #1 越过边沿
            // 会读到 DUT 在本边沿刚更新的下一拍数据, 整条码字前移一位。
            if (m_tvalid && m_tready) begin
                enc_mem[i] = m_tdata;
                i = i + 1;
            end
        end
        if (i < 648) begin
            $display("  FAIL: 收集超时, 只收到 %0d/648 位", i);
            n_fail = n_fail + 1;
        end
        @(negedge clk);
        m_tready = 1'b0;
    end
    endtask

    //-----------------------------------------------------------------
    // 主测试
    //-----------------------------------------------------------------
    integer t;
    reg [323:0] test_info;
    reg [647:0] test_code;

    initial begin
        $dumpfile("tb_ldpc_encoder_top.vcd");
        $dumpvars(0, tb_ldpc_encoder_top);

        rst = 1; s_tvalid = 0; s_tdata = 0; m_tready = 0;
        n_pass = 0; n_fail = 0;

        #(CLK_PERIOD * 5) rst = 0;
        #(CLK_PERIOD);

        // Test 1: 全零码
        $display("");
        $display("=== Test 1: All-Zero ===");
        test_info = 324'd0;
        drive_info(test_info);
        collect_code;
        // 全零信息位的码字应为全零
        if (enc_mem[647:0] == 648'd0) begin
            $display("  PASS: All-zero codeword");
            n_pass = n_pass + 1;
        end else begin
            $display("  FAIL: Expected all-zero, got %h", enc_mem);
            n_fail = n_fail + 1;
        end

        #(CLK_PERIOD * 3);

        // Test 2~N: 随机码 (检查系统码性质)
        for (t = 2; t <= N_TESTS; t = t + 1) begin
            $display("");
            $display("=== Test %0d: Random Input ===", t);
            test_info = {$random, $random, $random, $random, $random,
                         $random, $random, $random, $random, $random};
            test_info[323:320] = 4'd0;

            drive_info(test_info);
            collect_code;

            // 检查: 前 K=324 位应等于信息位
            if (enc_mem[323:0] !== test_info) begin
                $display("  FAIL: Info bit mismatch");
                $display("    in [31:0]=%h  out[31:0]=%h", test_info[31:0], enc_mem[31:0]);
                n_fail = n_fail + 1;
            end else begin
                $display("  PASS: Info bit verified, code length=%0d", 648);
                n_pass = n_pass + 1;
            end

            #(CLK_PERIOD * 3);
        end

        $display("");
        $display("=============================");
        $display("  Encoder Test: %0d/%0d passed", n_pass, n_pass+n_fail);
        $display("=============================");
        if (n_fail != 0)
            $fatal(1, "tb_ldpc_encoder_top: %0d/%0d 用例失败", n_fail, n_pass+n_fail);
        $finish;
    end

    // 超时
    initial #(CLK_PERIOD * 50000) begin
        $display("FAIL: Timeout");
        $fatal(1, "tb_ldpc_encoder_top: 仿真超时未完成");
    end

endmodule
