// ============================================================================
// tb_sync_cosim — sync_top 帧级黄金向量 bit-true 比对 (ADR-003)
// 流程:
//   ① 读 sync_stimulus.bin (N 行) 背靠背驱动 DUT
//   ② 读 expected_sync_out.bin (N-384 行, generate_vectors 位真镜像期望)
//   ③ 捕获 m_axis 输出, **逐字比对 (0 容差)**; X/Z 计为失配
//   ④ o_fft_start 输出样点序号必须 == 镜像 N_FINE (vector_config.txt);
//      o_sync_locked 必须置位; T1 符号表与 t1_sign_coeffs.txt 逐位核对
//   ⑤ +EVID_DIR 给定时落盘 alignment-report.json (G-B-03, 失败也落盘)
// 用法: vsim -c tb_sync_cosim +VEC_DIR=<models/comm/synch/vectors/>
//                            +EVID_DIR=<var/gates/pg/sync_top/>
// ============================================================================

`timescale 1ns / 1ps

module tb_sync_cosim;

    localparam int DATA_W = 16;
    localparam int P_DLY  = 384;

    string VEC_DIR;
    string EVID_DIR;
    bit    evid_en;

    logic        clk, rst;
    logic        s_tvalid, s_tready;
    logic [31:0] s_tdata;
    logic        m_tvalid;
    logic [31:0] m_tdata;
    logic        fft_start, sync_locked;

    sync_top #(.DATA_W(DATA_W)) dut (
        .i_clk         (clk),
        .i_rst         (rst),
        .s_axis_tvalid (s_tvalid),
        .s_axis_tready (s_tready),
        .s_axis_tdata  (s_tdata),
        .m_axis_tvalid (m_tvalid),
        .m_axis_tready (1'b1),
        .m_axis_tdata  (m_tdata),
        .o_fft_start   (fft_start),
        .o_sync_locked (sync_locked)
    );

    initial clk = 0;
    always #5 clk = ~clk;

    //=========================================================================
    // 向量装载
    //=========================================================================
    logic [31:0] stim_q [$];
    logic [31:0] gold_q [$];
    int t1_a [0:63], t1_b [0:63];
    int cfg_n_fine;

    task automatic load_file(input string path, ref logic [31:0] q [$]);
        integer fd, sr;
        logic [31:0] v;
        fd = $fopen(path, "r");
        if (fd == 0) $fatal(1, "无法打开向量文件: %s", path);
        while (!$feof(fd)) begin
            sr = $fscanf(fd, "%h\n", v);
            if (sr <= 0) break;
            q.push_back(v);
        end
        $fclose(fd);
    endtask

    task automatic load_meta();
        integer fd, sr;
        string  line;
        int     v;
        // T1 符号表
        fd = $fopen({VEC_DIR, "t1_sign_coeffs.txt"}, "r");
        if (fd == 0) $fatal(1, "无法打开 t1_sign_coeffs.txt");
        for (int k = 0; k < 64; k++) begin
            sr = $fscanf(fd, "%d %d\n", t1_a[k], t1_b[k]);
            if (sr != 2) $fatal(1, "t1_sign_coeffs.txt 第 %0d 行解析失败", k);
        end
        $fclose(fd);
        // N_FINE
        cfg_n_fine = -1;
        fd = $fopen({VEC_DIR, "vector_config.txt"}, "r");
        if (fd == 0) $fatal(1, "无法打开 vector_config.txt");
        while (!$feof(fd)) begin
            sr = $fgets(line, fd);
            if (sr <= 0) break;
            if ($sscanf(line, "N_FINE=%d", v) == 1) cfg_n_fine = v;
        end
        $fclose(fd);
        if (cfg_n_fine < 0) $fatal(1, "vector_config.txt 缺 N_FINE");
    endtask

    //=========================================================================
    // 捕获 (fft_start 必须与 m_axis 拍对齐)
    //=========================================================================
    logic [31:0] cap_q [$];
    int fft_out_idx = -1;

    always @(posedge clk) begin
        if (m_tvalid === 1'b1) begin
            if (fft_start === 1'b1) fft_out_idx <= cap_q.size();
            cap_q.push_back(m_tdata);
        end else if (fft_start === 1'b1) begin
            $fatal(1, "fft_start 脉冲未与 m_axis 有效拍对齐");
        end
    end

    //=========================================================================
    // 证据落盘 (G-B-03)
    //=========================================================================
    task automatic write_evidence(input int total, input int mismatch);
        int fd;
        if (!evid_en) return;
        fd = $fopen({EVID_DIR, "alignment-report.json"}, "w");
        if (fd == 0) $fatal(1, "无法写 %salignment-report.json", EVID_DIR);
        $fdisplay(fd, "{");
        $fdisplay(fd, "  \"bit_true\": %s,", (mismatch == 0) ? "true" : "false");
        $fdisplay(fd, "  \"total\": %0d,", total);
        $fdisplay(fd, "  \"mismatch\": %0d,", mismatch);
        $fdisplay(fd, "  \"pipeline_offset\": %0d,", P_DLY);
        $fdisplay(fd, "  \"tool\": \"ModelSim 10.6c\",");
        $fdisplay(fd, "  \"tb\": \"tb_sync_cosim (帧级, 0 容差, 含 fft_start 对齐与 T1 系数表核对)\",");
        $fdisplay(fd, "  \"vectors\": \"sync_stimulus.bin / expected_sync_out.bin (generate_vectors 位真镜像)\"");
        $fdisplay(fd, "}");
        $fclose(fd);
    endtask

    //=========================================================================
    // 主流程
    //=========================================================================
    int mismatch_cnt;
    int unsigned w;

    initial begin : p_watchdog
        #8ms;
        $fatal(1, "全局看门狗超时");
    end

    initial begin : p_main
        mismatch_cnt = 0;
        rst = 1'b1; s_tvalid = 1'b0; s_tdata = '0;
        repeat (10) @(posedge clk);
        rst = 1'b0;
        repeat (5) @(posedge clk);

        if (!$value$plusargs("VEC_DIR=%s", VEC_DIR))
            $fatal(1, "缺 +VEC_DIR — 向量权威位置 models/comm/synch/vectors/");
        evid_en = $value$plusargs("EVID_DIR=%s", EVID_DIR);

        load_file({VEC_DIR, "sync_stimulus.bin"},     stim_q);
        load_file({VEC_DIR, "expected_sync_out.bin"}, gold_q);
        load_meta();

        if (stim_q.size() - gold_q.size() != P_DLY)
            $fatal(1, "激励 %0d - 期望 %0d != DLY %0d",
                   stim_q.size(), gold_q.size(), P_DLY);
        if (gold_q.size() < 2048)
            $fatal(1, "期望 %0d < 2048 (G-B-03 下限)", gold_q.size());

        // T1 符号表逐位核对 (RTL localparam vs golden 导出)
        for (int k = 0; k < 64; k++) begin
            if ((dut.u_track.u_corr.P_SRE[k] ? 1 : -1) != t1_a[k] ||
                (dut.u_track.u_corr.P_SIM[k] ? 1 : -1) != t1_b[k])
                $fatal(1, "T1 符号表第 %0d 位与 golden 导出不一致", k);
        end
        $display("  T1 符号量化系数表 64 位与 golden 导出逐位一致");

        $display("================================================");
        $display("  sync 帧级 cosim: %0d 激励 / %0d 期望, 0 容差",
                 stim_q.size(), gold_q.size());
        $display("================================================");

        // 背靠背驱动 + 17 拍冲刷 (K 级 1 + 旋转流水 16: CE=beat, 流尾样点
        // 需额外拍推出; 冲刷样点本身在延迟线内, 不会出现在比对窗口)
        for (int n = 0; n < stim_q.size(); n++) begin
            s_tdata  <= stim_q[n];
            s_tvalid <= 1'b1;
            do @(posedge clk); while (s_tready !== 1'b1);
        end
        s_tdata <= '0;
        for (int n = 0; n < 17; n++) begin
            do @(posedge clk); while (s_tready !== 1'b1);
        end
        s_tvalid <= 1'b0;

        // 等全部输出
        w = 0;
        while (cap_q.size() < gold_q.size()) begin
            @(posedge clk);
            w++;
            if (w > 20000) $fatal(1, "输出超时: %0d / %0d", cap_q.size(), gold_q.size());
        end
        repeat (100) @(posedge clk);
        if (cap_q.size() != gold_q.size())
            $fatal(1, "输出点数 %0d != 期望 %0d", cap_q.size(), gold_q.size());

        // 逐字比对
        for (int i = 0; i < gold_q.size(); i++) begin
            if ((^cap_q[i]) === 1'bx) begin
                if (mismatch_cnt < 10)
                    $display("  [X/Z @ %0d] rtl=%08x — 计为失配", i, cap_q[i]);
                mismatch_cnt++;
            end else if (cap_q[i] !== gold_q[i]) begin
                if (mismatch_cnt < 10)
                    $display("  [MISMATCH @ %0d] golden=%08x rtl=%08x",
                             i, gold_q[i], cap_q[i]);
                mismatch_cnt++;
            end
        end

        // 锁定与 fft_start 对齐
        if (sync_locked !== 1'b1) begin
            $display("  [FAIL] 未锁定");
            mismatch_cnt++;
        end
        if (fft_out_idx != cfg_n_fine) begin
            $display("  [FAIL] fft_start 输出序号 %0d != 镜像 N_FINE %0d",
                     fft_out_idx, cfg_n_fine);
            mismatch_cnt++;
        end else begin
            $display("  fft_start 对齐镜像 N_FINE = %0d", cfg_n_fine);
        end

        $display("");
        $display("  比对: %0d 点, 失配 %0d", gold_q.size(), mismatch_cnt);
        write_evidence(gold_q.size(), mismatch_cnt);
        if (mismatch_cnt != 0)
            $fatal(1, "SYNC COSIM FAILED — %0d mismatches", mismatch_cnt);
        $display("================================================");
        $display("  SYNC COSIM PASSED — bit-true");
        $display("================================================");
        $finish;
    end

endmodule
