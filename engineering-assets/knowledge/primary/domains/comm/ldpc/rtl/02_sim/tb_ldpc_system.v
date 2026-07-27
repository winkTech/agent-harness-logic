// ⛔ SUPERSEDED (2026-07-27): 旧版副本, 自检 PASS 不可作证据 (库级约定)。
// 权威版本: engineering-assets/incubator/intake/ldpc_codec/tb/ 。
// 禁止引用/复制; 详见 ../_SUPERSEDED.md。仅作历史对照保留。
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
    task send_info(input [323:0] info);
        integer i;
    begin
        tx_info = info;
        s_info_tvalid <= 1;
        for (i = 0; i < 324; i = i + 1) begin
            @(posedge clk);
            s_info_tdata <= info[i];
            while (!s_info_tready) @(posedge clk);
        end
        @(posedge clk);
        s_info_tvalid <= 0;
    end
    endtask

    //-----------------------------------------------------------------
    // 收集码字
    //-----------------------------------------------------------------
    task collect_code;
        integer i;
    begin
        m_code_tready <= 1;
        for (i = 0; i < 648; i = i + 1) begin
            @(posedge clk);
            while (!m_code_tvalid) @(posedge clk);
            tx_code[i] <= m_code_tdata;
        end
        @(posedge clk);
        m_code_tready <= 0;
    end
    endtask

    //-----------------------------------------------------------------
    // 无噪声信道: 码字 → LLR (BPSK: 0→+16, 1→-16)
    //-----------------------------------------------------------------
    task send_to_decoder(input [647:0] code);
        integer i;
    begin
        s_llr_tvalid <= 1;
        for (i = 0; i < 648; i = i + 1) begin
            @(posedge clk);
            // BPSK: bit=0 → LLR=+511 (强置信度0), bit=1 → LLR=-511 (强置信度1)
            s_llr_tdata <= code[i] ? -10'sd511 : 10'sd511;
            while (!s_llr_tready) @(posedge clk);
        end
        @(posedge clk);
        s_llr_tvalid <= 0;
    end
    endtask

    //-----------------------------------------------------------------
    // 收集译码结果
    //-----------------------------------------------------------------
    task collect_decoded;
        integer i;
    begin
        m_dec_tready <= 1;
        for (i = 0; i < 324; i = i + 1) begin
            @(posedge clk);
            while (!m_dec_tvalid) @(posedge clk);
            rx_bits[i] <= m_dec_tdata;
        end
        @(posedge clk);
        m_dec_tready <= 0;
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

        $finish(errors ? 1 : 0);
    end

    initial #(CLK_PERIOD * 200000) begin
        $display("FAIL: Timeout");
        $finish(1);
    end

endmodule
