//-----------------------------------------------------------------
//              LDPC Encoder-Decoder System Testbench
//-----------------------------------------------------------------
// 功能: 编码器 → AWGN 信道 → 译码器 全链路验证
//
// 流程:
//   1. 编码: 随机 324b 信息位 → 648b 码字
//   2. 调制: 0→+LLR, 1→-LLR (BPSK)
//   3. 信道: 加高斯噪声 (可选 SNR)
//   4. 译码: LDPC 译码器恢复信息位
//   5. 对比: BER 统计
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module tb_ldpc_system;

    parameter CLK_PERIOD = 10;
    parameter N_TESTS    = 10;

    reg           clk, rst;

    // 编码器接口
    reg           s_info_tvalid, s_info_tdata;
    wire          s_info_tready;
    wire          m_code_tvalid, m_code_tdata;
    reg           m_code_tready;

    // 译码器接口
    reg  [9:0]    s_llr_tdata;
    reg           s_llr_tvalid;
    wire          s_llr_tready;
    wire          m_dec_tdata, m_dec_tvalid;
    reg           m_dec_tready;

    // 内部存储
    reg [323:0]   tx_info;
    reg [647:0]   tx_code;
    reg [323:0]   rx_bits;
    integer       rx_cnt;

    //-----------------------------------------------------------------
    // DUT: 编码器
    //-----------------------------------------------------------------
    ldpc_encoder_top u_enc (
        .i_clk_sys           (clk),
        .i_rst_sys           (rst),
        .s_axis_info_tdata   (s_info_tdata),
        .s_axis_info_tvalid  (s_info_tvalid),
        .s_axis_info_tready  (s_info_tready),
        .m_axis_code_tdata   (m_code_tdata),
        .m_axis_code_tvalid  (m_code_tvalid),
        .m_axis_code_tready  (m_code_tready)
    );

    //-----------------------------------------------------------------
    // DUT: 译码器
    //-----------------------------------------------------------------
    ldpc_decoder_top u_dec (
        .i_clk_sys          (clk),
        .i_rst_sys          (rst),
        .s_axis_llr_tdata   (s_llr_tdata),
        .s_axis_llr_tvalid  (s_llr_tvalid),
        .s_axis_llr_tready  (s_llr_tready),
        .m_axis_data_tdata  (m_dec_tdata),
        .m_axis_data_tvalid (m_dec_tvalid),
        .m_axis_data_tready (m_dec_tready)
    );

    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    //-----------------------------------------------------------------
    // 发送信息位到编码器
    //-----------------------------------------------------------------
    // 严格按 AXI4-Stream 握手推进 —— 索引只在 tvalid && tready 成交那一拍自增。
    //
    // 原写法是 `for(i..){ @(posedge clk); tdata <= info[i]; while(!tready) @(posedge clk); }`,
    // i 每轮无条件自增, 不确认本拍是否真的成交。编码器 2026-07-31 修掉"S_IDLE 就拉
    // ready 吃掉首位"之后 ready 只在 S_LOAD 有效, 这个驱动就与 DUT 失步 —— 实测
    // 全链路 TB 在第 1/10 个测试即超时。这与 rrc_polyphase_fir 0.4.0 记过的
    // "固定节拍驱动、不看 tready ⇒ 静默丢符号"是同一类缺陷。
    // 正确写法照抄同包 tb_ldpc_encoder_top.v 的 drive_info。
    task send_info(input [323:0] info);
        integer i;
    begin
        tx_info = info;
        i = 0;
        s_info_tvalid = 1'b1;
        s_info_tdata  = info[0];
        while (i < 324) begin
            @(posedge clk);
            if (s_info_tready) begin
                i = i + 1;
                #1;
                s_info_tdata = (i < 324) ? info[i] : 1'b0;
            end
        end
        @(negedge clk);
        s_info_tvalid = 1'b0;
    end
    endtask

    //-----------------------------------------------------------------
    // 收集码字
    //-----------------------------------------------------------------
    // 同 send_info: 只在 tvalid && tready 成交那一拍取样并自增
    task collect_code;
        integer i;
    begin
        i = 0;
        m_code_tready = 1'b1;
        while (i < 648) begin
            @(posedge clk);
            if (m_code_tvalid) begin
                tx_code[i] = m_code_tdata;
                i = i + 1;
            end
        end
        @(negedge clk);
        m_code_tready = 1'b0;
    end
    endtask

    //-----------------------------------------------------------------
    // 无噪声信道: 码字 → LLR (BPSK: 0→+16, 1→-16)
    //-----------------------------------------------------------------
    // 同 send_info: 只在成交那一拍推进
    // BPSK: bit=0 → LLR=+511 (强置信度 0), bit=1 → LLR=-511 (强置信度 1)
    task send_to_decoder(input [647:0] code);
        integer i;
    begin
        i = 0;
        s_llr_tvalid = 1'b1;
        s_llr_tdata  = code[0] ? -10'sd511 : 10'sd511;
        while (i < 648) begin
            @(posedge clk);
            if (s_llr_tready) begin
                i = i + 1;
                #1;
                s_llr_tdata = (i < 648) ? (code[i] ? -10'sd511 : 10'sd511) : 10'sd0;
            end
        end
        @(negedge clk);
        s_llr_tvalid = 1'b0;
    end
    endtask

    //-----------------------------------------------------------------
    // 收集译码结果
    //-----------------------------------------------------------------
    // 同 collect_code: 只在成交那一拍取样并自增
    task collect_decoded;
        integer i;
    begin
        i = 0;
        m_dec_tready = 1'b1;
        while (i < 324) begin
            @(posedge clk);
            if (m_dec_tvalid) begin
                rx_bits[i] = m_dec_tdata;
                i = i + 1;
            end
        end
        @(negedge clk);
        m_dec_tready = 1'b0;
    end
    endtask

    //-----------------------------------------------------------------
    // 主测试
    //-----------------------------------------------------------------
    integer t, errors, total;
    reg [323:0] test_info;

    initial begin
        $dumpfile("tb_ldpc_system.vcd");
        $dumpvars(0, tb_ldpc_system);

        rst = 1; s_info_tvalid = 0; s_info_tdata = 0;
        s_llr_tvalid = 0; s_llr_tdata = 0;
        m_code_tready = 0; m_dec_tready = 0;
        errors = 0; total = 0;

        #(CLK_PERIOD * 5) rst = 0;
        #(CLK_PERIOD);

        for (t = 1; t <= N_TESTS; t = t + 1) begin
            $display("");
            $display("=== System Test %0d/%0d ===", t, N_TESTS);

            // 随机信息位
            test_info = {$random, $random, $random, $random, $random,
                         $random, $random, $random, $random, $random};
            test_info[323:320] = 0;

            // 编码
            send_info(test_info);
            collect_code;

            // 无噪声信道 → 译码
            send_to_decoder(tx_code);
            collect_decoded;

            // 对比
            if (rx_bits === test_info) begin
                $display("  ✅ PASS: Bit-exact match (noise-free)");
            end else begin
                errors = errors + 1;
                $display("  ❌ FAIL: Bit mismatch");
            end
            total = total + 1;

            #(CLK_PERIOD * 5);
        end

        $display("");
        $display("╔══════════════════════════════════╗");
        $display("║    LDPC System Test Report       ║");
        $display("╠══════════════════════════════════╣");
        $display("║  Total: %0d                      ║", total);
        $display("║  Errors: %0d                     ║", errors);
        if (errors == 0)
            $display("║  Result: ✅ ALL PASSED            ║");
        else
            $display("║  Result: ❌ FAILED                ║");
        $display("╚══════════════════════════════════╝");

        // 原为 $finish(errors ? 1 : 0) —— **失败会被当成通过**。$finish(N) 的 N 是
        // 诊断详略等级(IEEE 1364/1800), 不是进程退出码。本包 README 早在 2026-07-28
        // 就点名记过这个写法, 当时只修了编码器 TB; 译码器 TB 于 1.0.2 补修,
        // 本全链路 TB 到 1.0.5 才跟上 —— 同一个坑在三个 TB 里各躺了一份。
        if (errors == 0) $finish(0);
        else             $fatal(1, "LDPC SYSTEM FAIL: %0d errors", errors);
    end

    // 看门狗按 N_TESTS 定额, 不再写死 200000 拍。
    // 原为固定 200000 拍(2 ms), 而单次编解码实测约 22000 拍 —— 10 次就要约 220000 拍,
    // 本来就超。修好握手驱动后 9/10 通过、第 10 个撞上这个额度, 暴露出看门狗额度
    // 从一开始就不够(此前握手缺陷让它在第 1 个测试就超时, 掩盖了这一层)。
    // 单次 25000 拍已含裕量(实测 ~22000), 再整体留一倍余量。
    localparam integer P_WDOG_CYCLES = N_TESTS * 25000 * 2;
    initial #(CLK_PERIOD * P_WDOG_CYCLES) begin
        // 超时用 $fatal: $finish(1) 会以 0 退出, 上游看不出跑飞了
        $fatal(1, "FAIL: Timeout (watchdog %0d cycles, N_TESTS=%0d)", P_WDOG_CYCLES, N_TESTS);
    end

endmodule
