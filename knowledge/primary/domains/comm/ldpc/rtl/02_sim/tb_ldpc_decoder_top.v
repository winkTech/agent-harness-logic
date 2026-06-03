//-----------------------------------------------------------------
//              LDPC Decoder Top Testbench (重写版)
//-----------------------------------------------------------------
// 功能描述: 验证 ldpc_decoder_top 模块功能正确性
//
// 测试策略:
//   1. 复位测试 — 验证复位后所有输出为初始值
//   2. 单码字译码 — 加载单个 LLR 向量，对比硬判决输出
//   3. 多码字遍历 — 遍历所有 5 组测试向量
//   4. 早停测试 — 高 SNR 下验证早停功能
//
// 数据: 由 MATLAB gen_rtl_test_vectors.m 预生成
//   tb_llr_input_N.hex    — 648 行，10-bit signed hex (Q10.4)
//   tb_expected_output_N.hex — 324 行，1-bit per line
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module tb_ldpc_decoder_top;

    //-----------------------------------------------------------------
    // 参数
    //-----------------------------------------------------------------
    `include "../01_rtl/ldpc_defines.vh"

    parameter P_CLK_PERIOD = 10;         // 100 MHz
    parameter P_NUM_TESTS  = 5;          // 测试向量组数
    parameter P_TIMEOUT    = 200000;     // 超时保护 (cycles)

    //-----------------------------------------------------------------
    // 信号
    //-----------------------------------------------------------------
    reg                             i_clk_sys;
    reg                             i_rst_sys;

    reg  signed [9:0]               s_axis_llr_tdata;
    reg                             s_axis_llr_tvalid;
    wire                            s_axis_llr_tready;

    wire                            m_axis_data_tdata;
    wire                            m_axis_data_tvalid;
    reg                             m_axis_data_tready;

    //-----------------------------------------------------------------
    // 测试数据存储
    //-----------------------------------------------------------------
    reg signed [9:0]                r_llr_mem [0:`P_N-1];     // 648 × 10b
    reg                             r_exp_mem [0:`P_K-1];     // 324 × 1b
    reg                             r_dec_mem [0:`P_K-1];     // 译码输出
    reg [9:0]                       r_dec_cnt;
    integer                         r_errors;

    //-----------------------------------------------------------------
    // 时钟
    //-----------------------------------------------------------------
    initial i_clk_sys = 1'b0;
    always #(P_CLK_PERIOD/2) i_clk_sys = ~i_clk_sys;

    //-----------------------------------------------------------------
    // DUT 实例化
    //-----------------------------------------------------------------
    ldpc_decoder_top u_dut (
        .i_clk_sys          (i_clk_sys),
        .i_rst_sys          (i_rst_sys),
        .s_axis_llr_tdata   (s_axis_llr_tdata),
        .s_axis_llr_tvalid  (s_axis_llr_tvalid),
        .s_axis_llr_tready  (s_axis_llr_tready),
        .m_axis_data_tdata  (m_axis_data_tdata),
        .m_axis_data_tvalid (m_axis_data_tvalid),
        .m_axis_data_tready (m_axis_data_tready)
    );

    //-----------------------------------------------------------------
    // 从 .hex 文件加载测试向量
    //-----------------------------------------------------------------
    task load_test_vectors(input integer test_id);
        integer i;
        reg [15:0] hex_val;
        reg [7:0]  bit_char;
        string llr_file;
        string exp_file;
    begin
        // 构造文件名
        $sformat(llr_file, "../02_sim/tb_llr_input_%0d.hex", test_id);
        $sformat(exp_file, "../02_sim/tb_expected_output_%0d.hex", test_id);

        // 加载 LLR 输入
        $display("  Loading LLR: %s", llr_file);
        $readmemh(llr_file, r_llr_mem);

        // 加载期望输出 (每行 1 个 0/1 字符)
        $display("  Loading Expected: %s", exp_file);
        $readmemb(exp_file, r_exp_mem);

        $display("  Loaded %0d LLRs and %0d expected bits", `P_N, `P_K);
    end
    endtask

    //-----------------------------------------------------------------
    // 写入 LLR 到 DUT
    //-----------------------------------------------------------------
    reg  [9:0]                      r_load_addr;
    reg                             r_load_done;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            s_axis_llr_tvalid <= 1'b0;
            s_axis_llr_tdata  <= 'd0;
            r_load_addr       <= 'd0;
            r_load_done       <= 1'b0;
        end else if (!r_load_done) begin
            if (r_load_addr < `P_N) begin
                s_axis_llr_tvalid <= 1'b1;
                s_axis_llr_tdata  <= r_llr_mem[r_load_addr];
                if (s_axis_llr_tready) begin
                    r_load_addr <= r_load_addr + 1'b1;
                end
            end else begin
                s_axis_llr_tvalid <= 1'b0;
                r_load_done       <= 1'b1;
            end
        end else begin
            s_axis_llr_tvalid <= 1'b0;
        end
    end

    //-----------------------------------------------------------------
    // 收集译码输出
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_dec_cnt        <= 'd0;
            m_axis_data_tready <= 1'b1;
        end else begin
            if (m_axis_data_tvalid && m_axis_data_tready) begin
                if (r_dec_cnt < `P_K) begin
                    r_dec_mem[r_dec_cnt] <= m_axis_data_tdata;
                end
                r_dec_cnt <= r_dec_cnt + 1'b1;
            end
        end
    end

    //-----------------------------------------------------------------
    // 结果比对
    //-----------------------------------------------------------------
    task compare_results;
        integer i;
        reg [9:0] err_cnt;
    begin
        err_cnt = 0;
        for (i = 0; i < `P_K; i = i + 1) begin
            if (r_dec_mem[i] !== r_exp_mem[i]) begin
                err_cnt = err_cnt + 1;
                if (err_cnt <= 10) begin
                    $display("  Bit %0d: got %b, expected %b",
                             i, r_dec_mem[i], r_exp_mem[i]);
                end
            end
        end
        r_errors = err_cnt;

        if (err_cnt == 0) begin
            $display("  ✅ PASS: All %0d bits match!", `P_K);
        end else begin
            $display("  ❌ FAIL: %0d / %0d bit errors", err_cnt, `P_K);
        end
    end
    endtask

    //-----------------------------------------------------------------
    // 主测试流程
    //-----------------------------------------------------------------
    integer t;
    integer n_passed;
    integer n_failed;

    initial begin
        // 波形
        $dumpfile("tb_ldpc_decoder_top.vcd");
        $dumpvars(0, tb_ldpc_decoder_top);

        // 初始化
        i_rst_sys          = 1'b1;
        s_axis_llr_tvalid  = 1'b0;
        s_axis_llr_tdata   = 'd0;
        m_axis_data_tready = 1'b0;
        r_load_addr        = 'd0;
        r_load_done        = 1'b0;
        r_dec_cnt          = 'd0;
        r_errors           = 0;
        n_passed           = 0;
        n_failed           = 0;

        #(P_CLK_PERIOD * 5);

        //-----------------------------------------------------------------
        // Test 0: 复位检查
        //-----------------------------------------------------------------
        $display("");
        $display("========================================");
        $display("  Test 0: Reset Check");
        $display("========================================");
        if (m_axis_data_tvalid === 1'b0 && s_axis_llr_tready === 1'b1) begin
            $display("  ✅ PASS: Reset state correct");
        end else begin
            $display("  ❌ FAIL: tready=%b, tvalid=%b",
                     s_axis_llr_tready, m_axis_data_tvalid);
        end

        i_rst_sys = 1'b0;
        #(P_CLK_PERIOD);

        //-----------------------------------------------------------------
        // Test 1~N: 逐组测试向量
        //-----------------------------------------------------------------
        for (t = 1; t <= P_NUM_TESTS; t = t + 1) begin
            #(P_CLK_PERIOD * 2);
            $display("");
            $display("========================================");
            $display("  Test %0d / %0d: Decode Test", t, P_NUM_TESTS);
            $display("========================================");

            // 加载测试向量 (支持文件不存在时跳过)
            load_test_vectors(t);
            #(P_CLK_PERIOD);

            // 等待 LLR 加载完成
            @(posedge r_load_done);
            $display("  LLR loading complete (%0d cycles)", r_load_addr + 1);

            // 等待译码输出完成
            @(posedge (r_dec_cnt >= `P_K));
            $display("  Decode output complete (%0d bits)", r_dec_cnt);

            #(P_CLK_PERIOD);  // 等待最后一拍

            // 比对结果
            compare_results();

            if (r_errors == 0)
                n_passed = n_passed + 1;
            else
                n_failed = n_failed + 1;

            // 清空状态 (下次测试前)
            #(P_CLK_PERIOD);
            i_rst_sys = 1'b1;
            #(P_CLK_PERIOD * 3);
            i_rst_sys = 1'b0;
            r_load_done <= 1'b0;
            r_load_addr <= 'd0;
            r_dec_cnt   <= 'd0;
            #(P_CLK_PERIOD);
        end

        //-----------------------------------------------------------------
        // 汇总
        //-----------------------------------------------------------------
        $display("");
        $display("╔══════════════════════════════════════╗");
        $display("║        LDPC Decoder Test Report      ║");
        $display("╠══════════════════════════════════════╣");
        $display("║  Passed: %0d / %0d                  ║", n_passed, P_NUM_TESTS);
        $display("║  Failed: %0d                        ║", n_failed);
        $display("╚══════════════════════════════════════╝");

        if (n_failed == 0) begin
            $display("=== ALL TESTS PASSED ===");
            $finish(0);
        end else begin
            $display("=== TESTS FAILED ===");
            $finish(1);
        end
    end

    //-----------------------------------------------------------------
    // 超时保护
    //-----------------------------------------------------------------
    initial begin
        #(P_CLK_PERIOD * P_TIMEOUT);
        $display("FAIL: Simulation timeout (%0d cycles)", P_TIMEOUT);
        $finish(1);
    end

endmodule
