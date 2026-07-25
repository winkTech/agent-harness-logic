//==============================================================================
// tb_rrc_polyphase_fir — 核级自检 + golden cosim Testbench (ModelSim/Questa)
// 场景:
//   1. 复位期间及刚释放, 输出恒为 0
//   2. 静默(零输入)时输出恒为 0 (无 latch/无游离态)
//   3. 冲激输入后 m_axis_tvalid 会拉高, 且输出出现非零响应 (FIR 通路活着)
//   4. 全程输出无 X/Z
//   5. 全向量 cosim: 512 符号(16QAM,Q2.14) vs golden 期望 2048 样点,
//      逐样点精确比对 + 流水延迟自动搜索(0..8), 结果写 JSON 证据 (G-B-03)
// 用法: vlog -sv rrc_polyphase_fir.sv tb_rrc_polyphase_fir.sv; vsim -c -do "run -all" work.tb_rrc_polyphase_fir
//==============================================================================
`timescale 1ns/1ps
module tb_rrc_polyphase_fir;

    localparam int DATA_W = 16;

    logic                i_clk;
    logic                i_rst;
    logic                s_axis_tvalid;
    logic                s_axis_tready;
    logic [DATA_W*2-1:0] s_axis_tdata;
    logic                m_axis_tvalid;
    logic                m_axis_tready;
    logic [DATA_W*2-1:0] m_axis_tdata;

    integer err_count = 0;
    integer resp_nonzero = 0;
    integer valid_seen = 0;

    // DUT
    rrc_polyphase_fir #(.DATA_W(DATA_W), .SPS(4)) u_fir (
        .i_clk(i_clk), .i_rst(i_rst),
        .s_axis_tvalid(s_axis_tvalid), .s_axis_tready(s_axis_tready), .s_axis_tdata(s_axis_tdata),
        .m_axis_tvalid(m_axis_tvalid), .m_axis_tready(m_axis_tready), .m_axis_tdata(m_axis_tdata)
    );

    // 时钟 250MHz
    initial i_clk = 1'b0;
    always #2 i_clk = ~i_clk;

    // 驱动一个符号 (I,Q)
    task send_sym(input signed [DATA_W-1:0] si, input signed [DATA_W-1:0] sq);
        begin
            @(posedge i_clk);
            s_axis_tvalid <= 1'b1;
            s_axis_tdata  <= {sq, si};
            @(posedge i_clk);
            while (!s_axis_tready) @(posedge i_clk);
            s_axis_tvalid <= 1'b0;
            s_axis_tdata  <= '0;
            repeat (4) @(posedge i_clk);   // 等 4 相
        end
    endtask

    // X/Z 监测 (valid 有效时输出不得含 X/Z)
    always @(posedge i_clk) begin
        if (!i_rst && m_axis_tvalid) begin
            if ($isunknown(m_axis_tdata)) begin
                err_count = err_count + 1;
                $display("[%0t] ERR: m_axis_tdata 含 X/Z", $time);
            end
            valid_seen = valid_seen + 1;
            if (m_axis_tdata !== '0) resp_nonzero = resp_nonzero + 1;
        end
    end

    initial begin
        i_rst = 1'b1;
        s_axis_tvalid = 1'b0;
        s_axis_tdata  = '0;
        m_axis_tready = 1'b1;

        // 场景1: 复位期间输出恒 0
        repeat (5) @(posedge i_clk);
        if (m_axis_tdata !== '0) begin err_count = err_count + 1; $display("ERR: 复位期间输出非 0"); end

        @(posedge i_clk); i_rst = 1'b0;
        @(posedge i_clk);
        if (m_axis_tdata !== '0) begin err_count = err_count + 1; $display("ERR: 复位刚释放输出非 0"); end

        // 场景2: 静默 8 拍, 输出应恒 0
        repeat (8) @(posedge i_clk);
        if (resp_nonzero != 0) begin err_count = err_count + 1; $display("ERR: 零输入却有非零输出"); end

        // 场景3: 冲激 + 几个符号, 期望 valid 拉高 + 出现非零响应
        send_sym(16'sd16384, 16'sd0);      // 冲激 (Q1.15 ~0.5)
        send_sym(16'sd0,      16'sd8192);
        send_sym(-16'sd16384, 16'sd0);
        send_sym(16'sd4096,   -16'sd4096);
        repeat (20) @(posedge i_clk);

        if (valid_seen == 0)   begin err_count = err_count + 1; $display("ERR: m_axis_tvalid 从未拉高"); end
        if (resp_nonzero == 0) begin err_count = err_count + 1; $display("ERR: FIR 无非零响应 (通路可能断)"); end

        // 场景5: 全向量 cosim vs golden
        run_cosim();

        // 结论
        $display("---- tb_rrc_polyphase_fir 结果 ----");
        $display("valid_seen=%0d resp_nonzero=%0d err_count=%0d", valid_seen, resp_nonzero, err_count);
        if (err_count == 0) $display("PASS: 全部不变量+cosim 通过");
        else                $display("FAIL: %0d 项失败", err_count);
        $finish;
    end

    //==========================================================================
    // 场景5: 全向量 cosim (bit-true 判定, G-B-03 证据)
    //==========================================================================
    localparam int N_IN  = 512;
    localparam int N_FLUSH = 4;      // 冲洗零符号: 覆盖 golden 群延迟裁剪的卷积尾部
    localparam int N_OUT = 2048;
    localparam int N_CAP = N_OUT + 96;
    localparam int MAX_OFF = 24;     // 流水延迟搜索上限 (理论 16 = 4 符号群延迟)
    // 向量路径由 run.do 经 +VEC_DIR / +RPT_F 注入（库级约定，见治理规范 §5.5）。
    // 权威位置 = models/comm/<algo>/vectors/；TB 内禁硬编码绝对路径。
    string VEC_DIR, STIM_F, EXP_F, RPT_F;

    logic [31:0] stim_mem [0:N_IN-1];
    logic [31:0] exp_mem  [0:N_OUT-1];
    logic [31:0] got_mem  [0:N_CAP-1];
    integer got_n = 0;
    bit cosim_on = 0;

    // cosim 采样器
    always @(posedge i_clk) begin
        if (cosim_on && !i_rst && m_axis_tvalid && m_axis_tready && got_n < N_CAP) begin
            got_mem[got_n] = m_axis_tdata;
            got_n = got_n + 1;
        end
    end

    task run_cosim();
        integer fd, n, code, mm, best_mm, best_off, off, i, fd_r;
        integer first_bad;
        logic [31:0] w;
        begin
            // 向量目录由 run.do 注入; 缺失即 fail-closed, 不得回落到任何默认路径
            if (!$value$plusargs("VEC_DIR=%s", VEC_DIR))
                $fatal(1, "[cosim] 缺 +VEC_DIR — 向量权威位置 models/comm/<algo>/vectors/, 须由 run.do 注入");
            if (!$value$plusargs("RPT_F=%s", RPT_F))
                $fatal(1, "[cosim] 缺 +RPT_F — 证据须写入 var/gates/pg/<asset_uid>/");
            STIM_F = {VEC_DIR, "rrc_stimulus.hex"};
            EXP_F  = {VEC_DIR, "expected_tx.hex"};

            // 读激励/期望
            fd = $fopen(STIM_F, "r"); n = 0;
            if (fd == 0) $fatal(1, "[cosim] 打不开激励 %s", STIM_F);
            while (!$feof(fd) && n < N_IN) begin code = $fscanf(fd, "%h\n", w); if (code == 1) stim_mem[n++] = w; end
            $fclose(fd);
            // 装载 0 样点必须炸, 否则后续比对 0 个样点会得到 0 失配 = 假绿
            if (n == 0) $fatal(1, "[cosim] 激励装载 0 符号 (%s) — 拒绝在空向量上比对", STIM_F);
            $display("[cosim] 载入激励 %0d 符号", n);

            fd = $fopen(EXP_F, "r"); n = 0;
            if (fd == 0) $fatal(1, "[cosim] 打不开期望 %s", EXP_F);
            while (!$feof(fd) && n < N_OUT) begin code = $fscanf(fd, "%h\n", w); if (code == 1) exp_mem[n++] = w; end
            $fclose(fd);
            if (n == 0) $fatal(1, "[cosim] 期望装载 0 样点 (%s) — 拒绝在空向量上比对", EXP_F);
            $display("[cosim] 载入期望 %0d 样点", n);

            // 复位后连续驱动 512 符号 (1 符号/4 拍)
            @(posedge i_clk); i_rst = 1'b1;
            repeat (4) @(posedge i_clk);
            i_rst = 1'b0; got_n = 0; cosim_on = 1;
            repeat (2) @(posedge i_clk);
            for (i = 0; i < N_IN + N_FLUSH; i++) begin
                s_axis_tvalid <= 1'b1; s_axis_tdata <= (i < N_IN) ? stim_mem[i] : 32'h0;
                @(posedge i_clk);
                s_axis_tvalid <= 1'b0; s_axis_tdata <= '0;
                repeat (3) @(posedge i_clk);
            end
            repeat (64) @(posedge i_clk);   // 冲洗流水尾部
            cosim_on = 0;
            $display("[cosim] 采集输出 %0d 样点", got_n);

            // 流水延迟自动搜索: expected[i] vs got[i+off]
            best_mm = -1; best_off = 0;
            for (off = 0; off <= MAX_OFF; off++) begin
                mm = 0;
                for (i = 0; i < N_OUT; i++) begin
                    if (i + off < got_n) begin
                        if (got_mem[i+off] !== exp_mem[i]) mm++;
                    end else mm++;
                end
                if (best_mm == -1 || mm < best_mm) begin best_mm = mm; best_off = off; end
            end

            // 报告首个失配便于诊断
            first_bad = -1;
            for (i = 0; i < N_OUT; i++) begin
                if (i + best_off < got_n && got_mem[i+best_off] !== exp_mem[i]) begin
                    if (first_bad == -1) first_bad = i;
                    if (i < first_bad + 4)
                        $display("[cosim] MISMATCH idx=%0d exp=%08h got=%08h", i, exp_mem[i], got_mem[i+best_off]);
                end
            end

            $display("[cosim] 结果: offset=%0d mismatch=%0d / %0d", best_off, best_mm, N_OUT);
            if (best_mm != 0) err_count = err_count + 1;

            // 写 JSON 证据 (G-B-03)
            fd_r = $fopen(RPT_F, "w");
            if (fd_r != 0) begin
                $fdisplay(fd_r, "{");
                $fdisplay(fd_r, "  \"id\": \"G-B-03\",");
                $fdisplay(fd_r, "  \"tool\": \"ModelSim vsim (tb_rrc_polyphase_fir scenario5)\",");
                $fdisplay(fd_r, "  \"golden\": \"model_comm_rrc (fixed_point, 16qam alpha=0.5 sps=4)\",");
                $fdisplay(fd_r, "  \"total\": %0d,", N_OUT);
                $fdisplay(fd_r, "  \"captured\": %0d,", got_n);
                $fdisplay(fd_r, "  \"pipeline_offset\": %0d,", best_off);
                $fdisplay(fd_r, "  \"mismatch\": %0d,", best_mm);
                $fdisplay(fd_r, "  \"bit_true\": %s", best_mm == 0 ? "true" : "false");
                $fdisplay(fd_r, "}");
                $fclose(fd_r);
            end
        end
    endtask

    // 超时保护
    initial begin
        #50000;
        $display("FAIL: 超时 (err_count=%0d)", err_count + 1);
        $finish;
    end

endmodule
