//-----------------------------------------------------------------
//  tb_ldpc_decoder_top —— LDPC 译码器 cosim testbench
//-----------------------------------------------------------------
//  证据产出 (供 tools/gate-runner.cjs 判 G-B-03):
//    <EVID_DIR>/alignment-report.json   {bit_true, mismatch, total, ...}
//
//  可选调试产出 (+TRACE): <EVID_DIR>/trace/rtl_trace_1.txt
//    逐边 (iter row j col lq lr llr), 与 golden 侧 dump_rtl_trace.m 导出的
//    golden_trace_1.hex 同列序, 可直接 diff 出第一处发散点。
//
//  向量: +VEC_DIR 注入, 不得硬编码路径。
//  fail-closed: 缺 plusarg、装载失败、比对不过, 一律非零退出。
//
//  与上一版的差别: 帧间**不再拉复位**。原 TB 每组向量之间强行复位, 正好
//  掩盖了"r_llr_load_done 无清零路径导致单帧锁死"这一缺陷; 连续多帧本身
//  就是该缺陷的回归判据。
//-----------------------------------------------------------------
`timescale 1ns / 1ps

module tb_ldpc_decoder_top;

    localparam P_N        = 648;
    localparam P_K        = 324;
    localparam P_NVEC     = 10;
    localparam P_CLK_HALF = 5;      // 10 ns 周期 = 100 MHz

    reg                 i_clk_sys = 1'b0;
    reg                 i_rst_sys = 1'b1;

    reg  signed [9:0]   s_axis_llr_tdata  = 10'd0;
    reg                 s_axis_llr_tvalid = 1'b0;
    wire                s_axis_llr_tready;

    wire                m_axis_data_tdata;
    wire                m_axis_data_tvalid;
    reg                 m_axis_data_tready = 1'b1;

    reg     bp_mode   = 1'b0;        // 1 = 下游随机撤 tready
    integer bp_stalls = 0;
    integer seed      = 32'h20260726;

    always #P_CLK_HALF i_clk_sys = ~i_clk_sys;

    // 背压驱动: bp_mode 打开时下游按固定 seed 随机撤 tready (约 30% 拍),
    // 并统计因此产生的停顿拍数, 作为"确实施加了背压"的量化证据。
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            m_axis_data_tready <= 1'b1;
        end else if (bp_mode) begin
            m_axis_data_tready <= ($random(seed) % 10) > 2;
            if (m_axis_data_tvalid && !m_axis_data_tready) bp_stalls <= bp_stalls + 1;
        end else begin
            m_axis_data_tready <= 1'b1;
        end
    end

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
    // 向量与证据路径 (plusarg 注入, 缺失即失败)
    //-----------------------------------------------------------------
    reg [8*512-1:0] vec_dir;
    reg [8*512-1:0] evid_dir;
    reg             do_trace;

    reg  [9:0]  llr_mem [0:P_N-1];
    reg         exp_mem [0:P_K-1];
    reg         got_mem [0:P_K-1];

    integer total_bits, total_mismatch, v, i, n_err, only_vec, n_fatal;
    integer frame_cycles, k2;
    reg     ref_bits [0:P_K-1];      // 确定性双跑比对用
    integer fd, trace_fd, timeout;

    reg [8*640-1:0] path;

    //-----------------------------------------------------------------
    // 逐边轨迹 (调试用, +TRACE 打开)
    // 写回相位上 cn_update 输出与 h_matrix 地址同拍有效, 直接取即可。
    //-----------------------------------------------------------------
    // ri_wb_idx 是"本拍正在算"的边; o_wb_valid 高的那拍输出的是**上一拍**
    // 算出来的边, 故轨迹要用打一拍的索引, 否则 j 列整体错位 1。
    reg [3:0] r_tr_idx_d1;
    always @(posedge i_clk_sys) r_tr_idx_d1 <= u_dut.u_cn_update.ri_wb_idx;

    always @(posedge i_clk_sys) begin
        if (do_trace && !i_rst_sys && (trace_fd != 0) && u_dut.w_cn_wb_valid) begin
            $fwrite(trace_fd, "%0d %0d %0d %0d %0d %0d %0d\n",
                    u_dut.u_controller.r_iter_cnt,
                    u_dut.u_controller.r_row_cnt,
                    r_tr_idx_d1,
                    u_dut.w_h_col_addr,
                    u_dut.w_cn_lq,
                    u_dut.w_cn_lr,
                    u_dut.w_vn_sat);
        end
    end

    //-----------------------------------------------------------------
    // 装载一组向量; 用 X 哨兵确认 $readmemh 真的读到了东西
    //-----------------------------------------------------------------
    task load_vector(input integer idx);
        begin
            for (i = 0; i < P_N; i = i + 1) llr_mem[i] = 10'bx;
            for (i = 0; i < P_K; i = i + 1) exp_mem[i] = 1'bx;

            $sformat(path, "%0s/tb_llr_input_%0d.hex", vec_dir, idx);
            $readmemh(path, llr_mem);
            $sformat(path, "%0s/tb_expected_output_%0d.hex", vec_dir, idx);
            $readmemb(path, exp_mem);

            if ((llr_mem[0] === 10'bx) || (llr_mem[P_N-1] === 10'bx)) begin
                $display("FATAL: LLR 向量 %0d 未装载 (首尾仍为 X) — VEC_DIR=%0s", idx, vec_dir);
                $finish(1);
            end
            if ((exp_mem[0] === 1'bx) || (exp_mem[P_K-1] === 1'bx)) begin
                $display("FATAL: 期望向量 %0d 未装载 (首尾仍为 X)", idx);
                $finish(1);
            end
        end
    endtask

    //-----------------------------------------------------------------
    // 跑一组向量: 送 648 个 LLR, 收 324 位硬判决
    //-----------------------------------------------------------------
    task run_vector(input integer idx, output integer err_cnt);
        integer k;
        begin
            err_cnt = 0;

            // --- 送 LLR (遵守 tready 握手) ---
            for (k = 0; k < P_N; k = k + 1) begin
                s_axis_llr_tvalid <= 1'b1;
                s_axis_llr_tdata  <= llr_mem[k];
                @(posedge i_clk_sys);
                while (!s_axis_llr_tready) @(posedge i_clk_sys);
            end
            s_axis_llr_tvalid <= 1'b0;
            s_axis_llr_tdata  <= 10'd0;

            // --- 收硬判决 ---
            k = 0;
            timeout = 0;
            while (k < P_K) begin
                @(posedge i_clk_sys);
                timeout = timeout + 1;
                if (timeout > 3000000) begin
                    $display("FATAL: 向量 %0d 超时 —— 只收到 %0d/%0d 位", idx, k, P_K);
                    $finish(1);
                end
                if (m_axis_data_tvalid && m_axis_data_tready) begin
                    got_mem[k] = m_axis_data_tdata;
                    k = k + 1;
                end
            end

            // --- 逐位比对 ---
            for (k = 0; k < P_K; k = k + 1) begin
                if (got_mem[k] !== exp_mem[k]) begin
                    if (err_cnt < 8)
                        $display("    bit %0d: got %b, expected %b", k, got_mem[k], exp_mem[k]);
                    err_cnt = err_cnt + 1;
                end
            end
        end
    endtask

    //-----------------------------------------------------------------
    // G-C-04: 逐寄存器复位比对
    //  去断言 +1 拍时, 每个已声明的状态/输出寄存器都必须等于其复位值。
    //-----------------------------------------------------------------
    integer rst_fd, rst_bad, rst_total;

    task check_reg(input [255:0] name, input integer got, input integer want);
        begin
            rst_total = rst_total + 1;
            if (got !== want) begin
                rst_bad = rst_bad + 1;
                $display("  RESET FAIL %0s: got %0d, want %0d", name, got, want);
                $fwrite(rst_fd, "%0s    {\"reg\": \"%0s\", \"got\": %0d, \"want\": %0d, \"pass\": false}",
                        (rst_total == 1) ? "" : ",\n", name, got, want);
            end else begin
                $fwrite(rst_fd, "%0s    {\"reg\": \"%0s\", \"got\": %0d, \"want\": %0d, \"pass\": true}",
                        (rst_total == 1) ? "" : ",\n", name, got, want);
            end
        end
    endtask

    task run_reset_check;
        begin
            rst_bad = 0; rst_total = 0;
            $sformat(path, "%0s/reset-sim.json", evid_dir);
            rst_fd = $fopen(path, "w");
            if (rst_fd == 0) begin $display("FATAL: 无法写 reset-sim.json"); $finish(1); end

            i_rst_sys = 1'b1;
            repeat (10) @(posedge i_clk_sys);
            @(posedge i_clk_sys);            // 去断言
            i_rst_sys = 1'b0;
            @(posedge i_clk_sys);            // +1 拍后采样

            $fwrite(rst_fd, "{\n  \"id\": \"G-C-04.reset\",\n");
            $fwrite(rst_fd, "  \"method\": \"deassert +1 clk, per-register compare vs declared reset value\",\n");
            $fwrite(rst_fd, "  \"registers\": [\n");

            check_reg("controller.r_cur_state",   u_dut.u_controller.r_cur_state,   10'b0000000001);
            check_reg("controller.r_row_cnt",     u_dut.u_controller.r_row_cnt,     0);
            check_reg("controller.r_conn_cnt",    u_dut.u_controller.r_conn_cnt,    0);
            check_reg("controller.r_iter_cnt",    u_dut.u_controller.r_iter_cnt,    0);
            check_reg("controller.r_drain_cnt",   u_dut.u_controller.r_drain_cnt,   0);
            check_reg("controller.r_ws_cnt",      u_dut.u_controller.r_ws_cnt,      0);
            check_reg("top.r_clear_cnt",          u_dut.r_clear_cnt,                0);
            check_reg("controller.r_synd_mode",   u_dut.u_controller.r_synd_mode,   0);
            check_reg("controller.ro_addr_en",    u_dut.u_controller.ro_addr_en,    0);
            check_reg("controller.ro_decode_done",u_dut.u_controller.ro_decode_done,0);
            check_reg("controller.ro_busy",       u_dut.u_controller.ro_busy,       0);
            check_reg("cn_update.r_min1",         u_dut.u_cn_update.r_min1,         {12{1'b1}});
            check_reg("cn_update.r_min2",         u_dut.u_cn_update.r_min2,         {12{1'b1}});
            check_reg("cn_update.r_min1_idx",     u_dut.u_cn_update.r_min1_idx,     0);
            check_reg("cn_update.r_prod_sign",    u_dut.u_cn_update.r_prod_sign,    0);
            check_reg("cn_update.ro_lr",          u_dut.u_cn_update.ro_lr,          0);
            check_reg("cn_update.ro_wb_valid",    u_dut.u_cn_update.ro_wb_valid,    0);
            check_reg("top.r_llr_load_addr",      u_dut.u_stream_io.r_llr_load_addr,            0);
            check_reg("top.r_llr_load_done",      u_dut.u_stream_io.r_llr_load_done,            0);
            check_reg("top.r_out_addr",           u_dut.u_stream_io.r_out_addr,                 0);
            check_reg("top.r_os",                 u_dut.u_stream_io.r_os,                       0);
            check_reg("top.ro_valid",             u_dut.u_stream_io.ro_valid,                   0);
            check_reg("top.r_synd_fail",          u_dut.r_synd_fail,                0);
            check_reg("top.r_row_par",            u_dut.r_row_par,                  0);
            check_reg("h_matrix.ro_valid",        u_dut.u_h_matrix_addr.ro_valid,   0);
            check_reg("h_matrix.ro_col_addr",     u_dut.u_h_matrix_addr.ro_col_addr,0);

            $fwrite(rst_fd, "\n  ],\n");
            $fwrite(rst_fd, "  \"total\": %0d,\n  \"failed\": %0d,\n", rst_total, rst_bad);
            $fwrite(rst_fd, "  \"pass\": %0s\n}\n", (rst_bad == 0) ? "true" : "false");
            $fclose(rst_fd);
            $display("  [G-C-04] 复位逐寄存器比对: %0d 个, %0d 个不符", rst_total, rst_bad);
            if (rst_bad != 0) n_fatal = n_fatal + 1;
        end
    endtask

    //-----------------------------------------------------------------
    // G-C-05 子结果写盘
    //-----------------------------------------------------------------
    task write_stab(input [255:0] name, input integer ok, input [512*8-1:0] reason);
        integer sfd;
        begin
            $sformat(path, "%0s/stability/%0s.json", evid_dir, name);
            sfd = $fopen(path, "w");
            if (sfd == 0) begin
                $display("FATAL: 无法写 stability/%0s.json (目录不存在?)", name);
                $finish(1);
            end
            $fwrite(sfd, "{\n  \"id\": \"G-C-05.%0s\",\n", name);
            $fwrite(sfd, "  \"pass\": %0s,\n", ok ? "true" : "false");
            $fwrite(sfd, "  \"reason\": \"%0s\"\n}\n", reason);
            $fclose(sfd);
            if (!ok) n_fatal = n_fatal + 1;
            $display("  [G-C-05.%0s] %0s — %0s", name, ok ? "pass" : "FAIL", reason);
        end
    endtask

    //-----------------------------------------------------------------
    // 主流程
    //-----------------------------------------------------------------
    initial begin
        if (!$value$plusargs("VEC_DIR=%s", vec_dir)) begin
            $display("FATAL: 缺 +VEC_DIR — TB 不得硬编码向量路径");
            $finish(1);
        end
        if (!$value$plusargs("EVID_DIR=%s", evid_dir)) begin
            $display("FATAL: 缺 +EVID_DIR");
            $finish(1);
        end
        do_trace = $test$plusargs("TRACE");
        trace_fd = 0;
        // +ONLY=<n> 只跑第 n 组 (定位单组失败是否为跨帧状态残留)
        if (!$value$plusargs("ONLY=%d", only_vec)) only_vec = 0;

        $display("=== tb_ldpc_decoder_top ===");
        $display("  VEC_DIR  = %0s", vec_dir);
        $display("  EVID_DIR = %0s", evid_dir);

        total_bits     = 0;
        total_mismatch = 0;
        n_fatal        = 0;
        bp_mode        = 1'b0;
        bp_stalls      = 0;
        seed           = 32'h20260726;

        i_rst_sys = 1'b1;
        repeat (20) @(posedge i_clk_sys);
        i_rst_sys = 1'b0;
        repeat (5) @(posedge i_clk_sys);

        // ---- G-C-04: 逐寄存器复位比对 (只在整批向量前做一次) ----
        if (only_vec == 0) begin
            run_reset_check();
            repeat (5) @(posedge i_clk_sys);
        end

        for (v = (only_vec ? only_vec : 1); v <= (only_vec ? only_vec : P_NVEC); v = v + 1) begin
            load_vector(v);

            if (do_trace && (v == (only_vec ? only_vec : 1))) begin
                $sformat(path, "%0s/trace/rtl_trace_%0d.txt", evid_dir, v);
                trace_fd = $fopen(path, "w");
                if (trace_fd == 0)
                    $display("WARNING: 无法打开轨迹文件 %0s", path);
            end

            run_vector(v, n_err);
            total_bits     = total_bits + P_K;
            total_mismatch = total_mismatch + n_err;
            $display("  vec %2d: %0d / %0d bit 失配   (synd_fail=%b)",
                     v, n_err, P_K, u_dut.r_synd_fail);

            if (trace_fd != 0) begin
                $fclose(trace_fd);
                trace_fd = 0;
            end

            repeat (20) @(posedge i_clk_sys);
        end

        //-------------------------------------------------------------
        // G-C-05 四个子结果 (只在整批模式下跑)
        //-------------------------------------------------------------
        if (only_vec == 0) begin

            // ---- regression: 全向量 bit-true + 同 seed 双跑一致 ----
            //  先存下第 1 组的输出, 复位后重跑同一组, 逐位比对。
            load_vector(1);
            run_vector(1, n_err);
            for (k2 = 0; k2 < P_K; k2 = k2 + 1) ref_bits[k2] = got_mem[k2];
            i_rst_sys = 1'b1; repeat (10) @(posedge i_clk_sys);
            i_rst_sys = 1'b0; repeat (5)  @(posedge i_clk_sys);
            load_vector(1);
            run_vector(1, n_err);
            i = 0;
            for (k2 = 0; k2 < P_K; k2 = k2 + 1)
                if (got_mem[k2] !== ref_bits[k2]) i = i + 1;
            write_stab("regression",
                       (total_mismatch == 0) && (i == 0),
                       "10 vectors 3240 bits bit-true vs fixed-point golden; same-input rerun bit-identical");

            // ---- boundary: 全零 LLR 与饱和 LLR, 不得出现 X/Z 或挂死 ----
            i_rst_sys = 1'b1; repeat (10) @(posedge i_clk_sys);
            i_rst_sys = 1'b0; repeat (5)  @(posedge i_clk_sys);
            for (k2 = 0; k2 < P_N; k2 = k2 + 1) llr_mem[k2] = 10'sd0;
            for (k2 = 0; k2 < P_K; k2 = k2 + 1) exp_mem[k2] = 1'b0;
            run_vector(0, n_err);          // 只看是否吐满 324 位且无 X
            i = 0;
            for (k2 = 0; k2 < P_K; k2 = k2 + 1)
                if (got_mem[k2] === 1'bx || got_mem[k2] === 1'bz) i = i + 1;
            // 饱和输入: 全 +511 与全 -512 交替
            for (k2 = 0; k2 < P_N; k2 = k2 + 1)
                llr_mem[k2] = (k2 % 2) ? 10'sd511 : -10'sd512;
            run_vector(0, n_err);
            for (k2 = 0; k2 < P_K; k2 = k2 + 1)
                if (got_mem[k2] === 1'bx || got_mem[k2] === 1'bz) i = i + 1;
            write_stab("boundary", (i == 0),
                       "all-zero LLR and full-scale +/-saturated LLR: 324 bits emitted, no X/Z, no hang");

            // ---- backpressure: 下游随机撤 tready, 重跑第 1 组 ----
            i_rst_sys = 1'b1; repeat (10) @(posedge i_clk_sys);
            i_rst_sys = 1'b0; repeat (5)  @(posedge i_clk_sys);
            bp_mode   = 1'b1;
            bp_stalls = 0;
            load_vector(1);
            run_vector(1, n_err);
            bp_mode = 1'b0;
            @(posedge i_clk_sys);
            $sformat(path,
                "downstream withdrew tready for %0d cycles; %0d/%0d bit mismatch vs golden",
                bp_stalls, n_err, P_K);
            write_stab("backpressure", (n_err == 0) && (bp_stalls > 100), path);

            // ---- stress: 单码字端到端周期数 ----
            //  预算依据 (行串行架构): 每迭代 = 324 行 x (ROWSTART 5 + READ ~7.4 +
            //  RDRAIN 5 + WB ~7.4 + WDRAIN 4) + syndrome 扫描 324 x ~22 约 1.7e4 拍;
            //  SNR 3dB 下 golden 3~5 次迭代收敛, 取 5 次 + 装载 + 输出 + 余量 = 1.5e5。
            i_rst_sys = 1'b1; repeat (10) @(posedge i_clk_sys);
            i_rst_sys = 1'b0; repeat (5)  @(posedge i_clk_sys);
            load_vector(1);
            frame_cycles = $time / (2*P_CLK_HALF);
            run_vector(1, n_err);
            frame_cycles = ($time / (2*P_CLK_HALF)) - frame_cycles;
            $sformat(path, "single codeword end-to-end %0d cycles (budget 150000, %0d bit mismatch)",
                     frame_cycles, n_err);
            write_stab("stress", (frame_cycles <= 150000) && (n_err == 0), path);
        end

        // --- 证据 ---
        $sformat(path, "%0s/alignment-report.json", evid_dir);
        fd = $fopen(path, "w");
        if (fd == 0) begin
            $display("FATAL: 无法写证据 %0s", path);
            $finish(1);
        end
        $fwrite(fd, "{\n");
        $fwrite(fd, "  \"id\": \"G-B-03\",\n");
        $fwrite(fd, "  \"tool\": \"ModelSim 10.6c\",\n");
        $fwrite(fd, "  \"golden\": \"models/comm/ldpc/src/ldpc_decoder_ms_fixed.m Q(10,4) alpha=12/16 max_iter=20 internal=10bit\",\n");
        $fwrite(fd, "  \"criterion\": \"324 hard-decision bits x %0d vectors, bitwise !==\",\n", P_NVEC);
        $fwrite(fd, "  \"total\": %0d,\n", total_bits);
        $fwrite(fd, "  \"mismatch\": %0d,\n", total_mismatch);
        $fwrite(fd, "  \"pipeline_offset\": 0,\n");
        $fwrite(fd, "  \"bit_true\": %0s\n", (total_mismatch == 0) ? "true" : "false");
        $fwrite(fd, "}\n");
        $fclose(fd);

        $display("=== 合计: %0d / %0d bit 失配, 其它场景失败 %0d ===",
                 total_mismatch, total_bits, n_fatal);
        if (total_mismatch == 0 && n_fatal == 0) begin
            $display("=== BIT-TRUE PASS ===");
            $finish(0);
        end else begin
            $display("=== BIT-TRUE FAIL ===");
            $finish(1);
        end
    end

endmodule
