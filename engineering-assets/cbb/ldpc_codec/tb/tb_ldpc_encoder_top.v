//-----------------------------------------------------------------
//              LDPC Encoder Testbench (bit-true vs MATLAB golden)
//-----------------------------------------------------------------
// 功能: 验证 ldpc_encoder_top 编码正确性
//
// 测试:
//   1) 复位后可接受流
//   2) 从 +VEC_DIR 加载 MATLAB 导出的 info/code 向量做 bit-true 比对
//      (gen_encoder_test_vectors.m → tb_enc_info_*.hex / tb_enc_code_*.hex)
//   3) 无向量文件时 fail-closed (非零退出), 不得假绿
//
// 采样约定 (2026-07-28 修正后保留):
//   - drive/collect 严格按 (tvalid && tready) 握手
//   - 在 @(posedge clk) active 区读总线 = 该边沿之前的值 (AXI-S 语义)
//   - 失败走 $fatal; 禁止 $finish(N) 当退出码
//
// Plusarg:
//   +VEC_DIR=<path>   向量目录 (必填) — tb_enc_info_*.hex / tb_enc_code_*.hex
//   +N_TESTS=N        覆盖默认 5 组 (1=全零, 2..N 随机 golden)
// DUT PT ROM: 仿真 CWD 需有 pt_columns.hex (从 rtl/ 复制), 见 ldpc_encoder_top
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module tb_ldpc_encoder_top;

    parameter CLK_PERIOD = 10;
    parameter P_K        = 324;
    parameter P_N        = 648;
    parameter P_NTESTS_D = 5;

    reg           clk, rst;
    reg           s_tvalid, s_tdata;
    wire          s_tready;
    wire          m_tvalid, m_tdata;
    reg           m_tready;

    reg           info_bits [0:P_K-1];
    reg           code_exp  [0:P_N-1];
    reg           code_got  [0:P_N-1];

    integer       n_pass, n_fail, n_tests, t, i, n_err, guard;
    reg [8*512-1:0] vec_dir;
    reg [8*640-1:0] path;
    integer       fd;

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
    // 加载一组 golden (info + expected codeword)
    //-----------------------------------------------------------------
    task load_vec;
        input integer idx;
        integer k, c, v;
    begin
        // 与 decoder TB 相同: "%0s/file" (VEC_DIR 可带或不带尾斜杠均可)
        $sformat(path, "%0s/tb_enc_info_%0d.hex", vec_dir, idx);
        fd = $fopen(path, "r");
        if (fd == 0)
            $fatal(1, "tb_ldpc_encoder_top: 打不开 %0s (先跑 models/comm/ldpc/gen_encoder_test_vectors.m)", path);
        for (k = 0; k < P_K; k = k + 1) begin
            if ($fscanf(fd, "%d\n", v) != 1)
                $fatal(1, "tb_ldpc_encoder_top: info 向量 %0d 行不足 (idx=%0d)", k, idx);
            info_bits[k] = v[0];
        end
        $fclose(fd);

        $sformat(path, "%0s/tb_enc_code_%0d.hex", vec_dir, idx);
        fd = $fopen(path, "r");
        if (fd == 0)
            $fatal(1, "tb_ldpc_encoder_top: 打不开 %0s", path);
        for (c = 0; c < P_N; c = c + 1) begin
            if ($fscanf(fd, "%d\n", v) != 1)
                $fatal(1, "tb_ldpc_encoder_top: code 向量 %0d 行不足 (idx=%0d)", c, idx);
            code_exp[c] = v[0];
        end
        $fclose(fd);

        // 系统码性质 (golden 自检)
        for (k = 0; k < P_K; k = k + 1) begin
            if (code_exp[k] !== info_bits[k])
                $fatal(1, "tb_ldpc_encoder_top: golden 破坏系统码性质 idx=%0d bit=%0d", idx, k);
        end
    end
    endtask

    //-----------------------------------------------------------------
    // 驱动: 发送信息位 (严格按 AXI4-Stream 握手)
    //-----------------------------------------------------------------
    task drive_info;
        integer j;
    begin
        j = 0;
        s_tvalid = 1'b1;
        s_tdata  = info_bits[0];
        while (j < P_K) begin
            @(posedge clk);
            if (s_tready) begin
                j = j + 1;
                #1;
                s_tdata = (j < P_K) ? info_bits[j] : 1'b0;
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
        integer j;
    begin
        m_tready = 1'b1;
        j     = 0;
        guard = 0;
        while (j < P_N && guard < 200000) begin
            @(posedge clk);
            guard = guard + 1;
            if (m_tvalid && m_tready) begin
                code_got[j] = m_tdata;
                j = j + 1;
            end
        end
        if (j < P_N) begin
            $display("  FAIL: 收集超时, 只收到 %0d/%0d 位", j, P_N);
            n_fail = n_fail + 1;
        end
        @(negedge clk);
        m_tready = 1'b0;
    end
    endtask

    //-----------------------------------------------------------------
    // bit-true 比对
    //-----------------------------------------------------------------
    task compare_code;
        input integer idx;
        integer j;
        integer first;
    begin
        n_err = 0;
        first = -1;
        for (j = 0; j < P_N; j = j + 1) begin
            if (code_got[j] !== code_exp[j]) begin
                n_err = n_err + 1;
                if (first < 0) first = j;
            end
        end
        if (n_err == 0) begin
            $display("  PASS: vec %0d bit-true (0/%0d mismatch)", idx, P_N);
            n_pass = n_pass + 1;
        end else begin
            $display("  FAIL: vec %0d  %0d/%0d bit mismatch (first@%0d got=%0d exp=%0d)",
                     idx, n_err, P_N, first, code_got[first], code_exp[first]);
            n_fail = n_fail + 1;
        end
    end
    endtask

    //-----------------------------------------------------------------
    // 主测试
    //-----------------------------------------------------------------
    initial begin
        // ModelSim 经 +VEC_DIR 传绝对路径; xsim 传不了含盘符的路径 (-testplusarg 会在
        // `=` 与冒号处把参数切碎), 故回落到运行目录相对 —— 由 run_xsim.sh 先把
        // tb_enc_info_*.hex / tb_enc_code_*.hex 拷进构建目录。
        // 回落值用 "." 而非空串: 下面拼路径是 $sformat("%0s/xxx", vec_dir)。
        if (!$value$plusargs("VEC_DIR=%s", vec_dir)) vec_dir = ".";
        if (!$value$plusargs("N_TESTS=%d", n_tests))
            n_tests = P_NTESTS_D;

        $display("=== tb_ldpc_encoder_top (bit-true) ===");
        $display("  VEC_DIR = %0s", vec_dir);
        $display("  N_TESTS = %0d", n_tests);

        rst = 1; s_tvalid = 0; s_tdata = 0; m_tready = 0;
        n_pass = 0; n_fail = 0;

        #(CLK_PERIOD * 5) rst = 0;
        #(CLK_PERIOD);

        for (t = 1; t <= n_tests; t = t + 1) begin
            $display("");
            $display("=== Test %0d / %0d ===", t, n_tests);
            load_vec(t);
            drive_info;
            collect_code;
            compare_code(t);
            #(CLK_PERIOD * 3);
        end

        $display("");
        $display("=============================");
        $display("  Encoder bit-true: %0d/%0d passed", n_pass, n_pass + n_fail);
        $display("=============================");
        if (n_fail != 0)
            $fatal(1, "tb_ldpc_encoder_top: %0d/%0d 用例失败", n_fail, n_pass + n_fail);
        $display("=== ENCODER BIT-TRUE PASS ===");
        $finish;
    end

    initial #(CLK_PERIOD * 500000) begin
        $display("FAIL: Timeout");
        $fatal(1, "tb_ldpc_encoder_top: 仿真超时未完成");
    end

endmodule
