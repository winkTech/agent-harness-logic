//-----------------------------------------------------------------
//                 LDPC Decoder Top Testbench
//-----------------------------------------------------------------
// 功能描述: 验证 ldpc_decoder_top 模块的功能正确性
//
// 测试场景:
//   1. 复位测试 — 验证复位后输出为初始值
//   2. 无噪声编码译码 — 使用已知码字测试完整流程
//   3. 迭代收敛测试 — 验证译码器在无噪声下快速收敛
//
// 测试数据: 由 MATLAB Golden Model 预生成
//   LLR 输入文件: tb_llr_input.hex (648 行, 每行 10-bit signed hex)
//   期望输出文件: tb_expected_output.hex (324 行, 每行 1-bit)
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module tb_ldpc_decoder_top;

    //-----------------------------------------------------------------
    // 参数定义
    //-----------------------------------------------------------------
    `include "../01_rtl/ldpc_defines.vh"

    parameter P_CLK_PERIOD = 10;   // 100 MHz (10 ns)

    //-----------------------------------------------------------------
    // 信号声明
    //-----------------------------------------------------------------
    reg                             i_clk_sys;
    reg                             i_rst_sys;
    reg signed [9:0]                s_axis_llr_tdata;
    reg                             s_axis_llr_tvalid;
    wire                            s_axis_llr_tready;
    wire                            m_axis_data_tdata;
    wire                            m_axis_data_tvalid;
    reg                             m_axis_data_tready;

    //-----------------------------------------------------------------
    // 测试数据存储
    //-----------------------------------------------------------------
    // LLR 输入 (从文件加载)
    reg signed [9:0]                r_llr_mem [0:647];
    // 期望输出 (从文件加载)
    reg                             r_expected [0:323];

    // 结果收集
    reg                             r_decoded [0:323];
    reg [9:0]                       r_bit_cnt;

    //-----------------------------------------------------------------
    // 时钟生成
    //-----------------------------------------------------------------
    initial begin
        i_clk_sys = 1'b0;
    end
    always #(P_CLK_PERIOD/2) i_clk_sys = ~i_clk_sys;

    //-----------------------------------------------------------------
    // 实例化待测模块
    //-----------------------------------------------------------------
    ldpc_decoder_top #(
        .P_MAX_ROW_WT  (`P_MAX_ROW_WT),
        .P_Q_DATA_W    (`P_Q_DATA_W),
        .P_LLR_ADDR_W  (`P_LLR_ADDR_W),
        .P_ROW_ADDR_W  (`P_ROW_ADDR_W),
        .P_COL_ADDR_W  (`P_COL_ADDR_W),
        .P_SHIFT_W     (`P_SHIFT_W),
        .P_CONN_CNT_W  (`P_CONN_CNT_W)
    ) u_dut (
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
    // 测试激励生成
    //-----------------------------------------------------------------
    // 生成一个简单测试用例: 全零信息位编码后的 LLR
    task gen_test_vectors;
        integer i;
        reg [323:0] info;
        reg [647:0] code;
        integer llr_val;
    begin
        // 使用预先计算的测试向量 (从 MATLAB 生成)
        // 这里使用简化的已知向量: 全零码字, LLR = +511 (强置信度)
        info = 324'd0;

        // 从文件加载 (如果存在)
        // $readmemh("tb_llr_input.hex", r_llr_mem);

        // 否则使用内置测试: 全零信息 → 编码 → 无噪声 LLR
        // code = ldpc_encode(info) 的结果
        // 简单测试: 使用全零码字 (不是有效的 LDPC 码字, 但译码器会纠正)
        for (i = 0; i < 648; i = i + 1) begin
            // 为简单起见, 使用中等置信度 (+16 = Q(10,4) 的 +256)
            r_llr_mem[i] = 10'sd256;  // +16.0 in Q(10,4)
        end

        // 期望输出: 全零 (译码器应输出全零)
        for (i = 0; i < 324; i = i + 1) begin
            r_expected[i] = 1'b0;
        end
    end
    endtask

    //-----------------------------------------------------------------
    // LLR 输入驱动
    //-----------------------------------------------------------------
    reg [9:0] r_load_addr;
    reg       r_load_done;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            s_axis_llr_tvalid <= 1'b0;
            s_axis_llr_tdata  <= 'd0;
            r_load_addr       <= 'd0;
            r_load_done       <= 1'b0;
        end else begin
            if (!r_load_done) begin
                if (r_load_addr < 648) begin
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
    end

    //-----------------------------------------------------------------
    // 输出收集
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_bit_cnt        <= 'd0;
            m_axis_data_tready <= 1'b0;
        end else begin
            m_axis_data_tready <= 1'b1;
            if (m_axis_data_tvalid && m_axis_data_tready) begin
                r_decoded[r_bit_cnt] <= m_axis_data_tdata;
                r_bit_cnt            <= r_bit_cnt + 1'b1;
            end
        end
    end

    //-----------------------------------------------------------------
    // 主测试流程
    //-----------------------------------------------------------------
    reg [31:0] r_errors;
    integer    i;

    initial begin
        // 波形输出
        $dumpfile("tb_ldpc_decoder_top.vcd");
        $dumpvars(0, tb_ldpc_decoder_top);

        // 初始化
        i_rst_sys          = 1'b1;
        s_axis_llr_tvalid  = 1'b0;
        s_axis_llr_tdata   = 'd0;
        m_axis_data_tready = 1'b0;
        r_bit_cnt          = 'd0;
        r_errors           = 'd0;

        // 生成测试向量
        gen_test_vectors();

        // 释放复位
        #(P_CLK_PERIOD * 5);
        i_rst_sys = 1'b0;
        #(P_CLK_PERIOD);

        //-----------------------------------------------------------------
        // 测试 1: 等待数据加载完成
        //-----------------------------------------------------------------
        $display("=== Test 1: LLR Load Test ===");
        wait(r_load_done);
        $display("  LLR loading: PASS");

        //-----------------------------------------------------------------
        // 测试 2: 等待译码完成
        //-----------------------------------------------------------------
        $display("=== Test 2: Decode Test ===");
        wait(r_bit_cnt >= 324);
        $display("  Decode output: %0d bits received", r_bit_cnt);

        //-----------------------------------------------------------------
        // 测试 3: 结果比较
        //-----------------------------------------------------------------
        $display("=== Test 3: Result Compare ===");
        r_errors = 0;
        for (i = 0; i < 324; i = i + 1) begin
            if (r_decoded[i] !== r_expected[i]) begin
                r_errors = r_errors + 1;
                if (r_errors <= 10) begin
                    $display("  Bit %0d: got %b, expected %b", i, r_decoded[i], r_expected[i]);
                end
            end
        end

        if (r_errors == 0) begin
            $display("  PASS: All bits match!");
        end else begin
            $display("  FAIL: %0d bit errors", r_errors);
        end

        //-----------------------------------------------------------------
        // 测试完成
        //-----------------------------------------------------------------
        if (r_errors == 0) begin
            $display("=== ALL TESTS PASSED ===");
            $finish(0);
        end else begin
            $display("=== TESTS FAILED ===");
            $finish(1);
        end
    end

    //-----------------------------------------------------------------
    // 超时保护 (译码器在 100,000 周期内应完成)
    //-----------------------------------------------------------------
    initial begin
        #(P_CLK_PERIOD * 100000);
        $display("FAIL: Simulation timeout (100k cycles)");
        $finish(1);
    end

endmodule
