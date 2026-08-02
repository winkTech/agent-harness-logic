// ============================================================================
// tb_chEst_cosim — 帧级黄金向量 bit-true 比对 (ADR-002 架构)
// 流程:
//   ① 读 rx_chEst_frame.hex ((2+nsym)×64 行, LTS1/LTS2/数据符号) 驱动 DUT
//   ② 读 expected_chEst_frame.hex (nsym×64 行, 位真镜像期望)
//   ③ 捕获 nsym×64 点输出, 写 rtl_chEst_frame_out.hex 供 MATLAB 外部分析
//   ④ **逐字比对 (0 容差)** — 期望由 generate_vectors.m 位真镜像生成,
//      任何比特差异即失配; X/Z 显式计为失配 (规范 §5.5 V-5)
//   ⑤ 任一失配 $fatal (非零退出); 通过打印 "CHEST COSIM PASSED"
// 用法: vsim -c tb_chEst_cosim +VEC_DIR=<models/comm/channel_est/vectors/>
//                              +EVID_DIR=<var/gates/pg/channel_est_top/>
//   向量目录缺失即 fail-closed, 不回落默认路径 (规范 §5.5 V-2)
//   +EVID_DIR 给定时落盘 alignment-report.json (G-B-03 证据; 失败也落盘)
// nsym 由文件行数自推: 期望行数/64; 激励行数须等于 (2+nsym)×64
// G-B-03 要求 total>=2048 → 向量须以 nsym>=32 生成 (generate_vectors nsym=32)
// ============================================================================

`timescale 1ns / 1ps

module tb_chEst_cosim;

    localparam int DATA_W     = 16;
    localparam int N_FFT      = 64;
    localparam int CLK_PERIOD = 10;      // 100 MHz
    localparam int GAP        = 16;      // 符号间空闲拍 (CP 近似)

    string VEC_DIR;
    string EVID_DIR;
    bit    evid_en;

    logic         clk, rst, fs;
    logic         s_axis_tvalid, s_axis_tready;
    logic [31:0]  s_axis_tdata;
    logic         m_axis_tvalid, m_axis_tready;
    logic [31:0]  m_axis_tdata;

    channel_est_top #(
        .DATA_W(DATA_W)
    ) dut (
        .i_clk          (clk),
        .i_rst          (rst),
        .i_frame_start  (fs),
        .s_axis_tvalid  (s_axis_tvalid),
        .s_axis_tready  (s_axis_tready),
        .s_axis_tdata   (s_axis_tdata),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tdata   (m_axis_tdata)
    );

    initial clk = 0;
    always #(CLK_PERIOD/2) clk = ~clk;

    // ========================================================================
    // 向量装载
    // ========================================================================
    logic [31:0] stim_q [$];
    logic [31:0] gold_q [$];
    int nsym;

    task automatic load_file(input string path, ref logic [31:0] q [$]);
        integer fd, scan_ret;
        logic [31:0] v;
        fd = $fopen(path, "r");
        if (fd == 0) $fatal(1, "无法打开向量文件: %s", path);
        while (!$feof(fd)) begin
            scan_ret = $fscanf(fd, "%h\n", v);
            if (scan_ret <= 0) break;
            q.push_back(v);
        end
        $fclose(fd);
    endtask

    // ========================================================================
    // 输出捕获 (独立进程, 握手采样)
    // ========================================================================
    logic [31:0] cap_q [$];

    always @(posedge clk) begin
        if (m_axis_tvalid === 1'b1 && m_axis_tready === 1'b1)
            cap_q.push_back(m_axis_tdata);
    end

    // ========================================================================
    // 驱动
    // ========================================================================
    task automatic send_beat(input logic [31:0] d);
        int unsigned w;
        s_axis_tdata  <= d;
        s_axis_tvalid <= 1'b1;
        w = 0;
        do begin
            @(posedge clk);
            w++;
            if (w > 5000) $fatal(1, "send_beat: s_axis_tready 超时");
        end while (s_axis_tready !== 1'b1);
    endtask

    // ========================================================================
    // G-B-03 证据落盘 (成功/失败都写, fail-closed 审计)
    // ========================================================================
    task automatic write_evidence(input int total, input int mismatch);
        int fd;
        if (!evid_en) return;
        fd = $fopen({EVID_DIR, "alignment-report.json"}, "w");
        if (fd == 0) $fatal(1, "无法写 %salignment-report.json", EVID_DIR);
        $fdisplay(fd, "{");
        $fdisplay(fd, "  \"bit_true\": %s,", (mismatch == 0) ? "true" : "false");
        $fdisplay(fd, "  \"total\": %0d,", total);
        $fdisplay(fd, "  \"mismatch\": %0d,", mismatch);
        $fdisplay(fd, "  \"pipeline_offset\": 0,");
        $fdisplay(fd, "  \"tool\": \"ModelSim 10.6c\",");
        $fdisplay(fd, "  \"tb\": \"tb_chEst_cosim (帧级, 握手对齐, 0 容差)\",");
        $fdisplay(fd, "  \"vectors\": \"rx_chEst_frame.hex / expected_chEst_frame.hex (generate_vectors 位真镜像)\"");
        $fdisplay(fd, "}");
        $fclose(fd);
    endtask

    // ========================================================================
    // 主流程
    // ========================================================================
    int mismatch_cnt, out_fd;
    logic [31:0] got, exp;
    int unsigned w;

    initial begin : p_watchdog
        #8ms;
        $fatal(1, "全局看门狗超时");
    end

    initial begin : p_main
        mismatch_cnt = 0;
        rst = 1'b1; fs = 1'b0; s_axis_tvalid = 1'b0; s_axis_tdata = '0;
        m_axis_tready = 1'b1;
        repeat (10) @(posedge clk);
        rst = 1'b0;
        repeat (5) @(posedge clk);

        // 路径注入两条通路, TB 内均不出现硬编码绝对路径:
        //   ModelSim: run_cosim.do 经 +VEC_DIR / +EVID_DIR 传绝对路径
        //   xsim    : -testplusarg 在 Windows 上会在 `=` 与盘符处把参数切碎, 传不了
        //             路径, 故回落到**运行目录相对** —— 由 run_xsim.sh 先把向量拷进
        //             构建目录、跑完再把证据搬到 var/gates/pg/<asset_uid>/。
        // 回落的是"相对当前工作目录"而非某个写死的位置, 治理规范禁的是后者。
        // 注意 evid_en 取不到时若保持 0, 整段证据会静默不写 —— 那正是同类 TB 在
        // xsim 下"跑通却零证据"的成因 (见 axis_skid_buffer 1.0.1)。
        if (!$value$plusargs("VEC_DIR=%s", VEC_DIR)) VEC_DIR = "";
        if (!$value$plusargs("EVID_DIR=%s", EVID_DIR)) EVID_DIR = "";
        evid_en = 1'b1;

        load_file({VEC_DIR, "rx_chEst_frame.hex"},       stim_q);
        load_file({VEC_DIR, "expected_chEst_frame.hex"}, gold_q);

        if (gold_q.size() == 0 || (gold_q.size() % N_FFT) != 0)
            $fatal(1, "期望行数 %0d 不是 64 的正整数倍", gold_q.size());
        nsym = gold_q.size() / N_FFT;
        if (stim_q.size() != (2 + nsym) * N_FFT)
            $fatal(1, "激励行数 %0d != (2+%0d)x64", stim_q.size(), nsym);

        $display("================================================");
        $display("  chEst 帧级 cosim: 2 LTS + %0d 数据符号, 0 容差", nsym);
        $display("================================================");

        // 帧起始脉冲 (领先 LTS1 >= 1 拍)
        @(posedge clk); fs <= 1'b1;
        @(posedge clk); fs <= 1'b0;
        @(posedge clk);

        for (int s = 0; s < 2 + nsym; s++) begin
            for (int k = 0; k < N_FFT; k++) send_beat(stim_q[s*N_FFT + k]);
            s_axis_tvalid <= 1'b0;
            repeat (GAP) @(posedge clk);
        end

        // 等全部输出
        w = 0;
        while (cap_q.size() < nsym * N_FFT) begin
            @(posedge clk);
            w++;
            if (w > 100000) $fatal(1, "输出超时: %0d / %0d", cap_q.size(), nsym*N_FFT);
        end
        repeat (200) @(posedge clk);
        if (cap_q.size() != nsym * N_FFT)
            $fatal(1, "输出点数 %0d != 期望 %0d (多余输出)", cap_q.size(), nsym*N_FFT);

        // 落盘 + 逐字比对
        // 写 EVID_DIR 而不是 VEC_DIR: 这是**RTL 的输出**, 不是 golden 期望值。
        // 原先写进 models/comm/channel_est/vectors/ —— 那是 golden 向量的权威目录,
        // 把 RTL 产物混在期望值旁边, 迟早会被谁当成期望值用; 实测它也确实以未提交
        // 状态在那里躺了很久 (rtl_chEst_frame_out.hex)。证据目录才是它该待的地方。
        out_fd = $fopen({EVID_DIR, "rtl_chEst_frame_out.hex"}, "w");
        if (out_fd == 0) $fatal(1, "无法创建 rtl_chEst_frame_out.hex");
        for (int i = 0; i < nsym * N_FFT; i++) begin
            got = cap_q[i];
            exp = gold_q[i];
            $fwrite(out_fd, "%08x\n", got);
            if ((^got) === 1'bx) begin
                if (mismatch_cnt < 10)
                    $display("  [X/Z @ sym%0d sc%0d] rtl=%08x — 计为失配",
                             i/N_FFT, i%N_FFT, got);
                mismatch_cnt++;
            end else if (got !== exp) begin
                if (mismatch_cnt < 10)
                    $display("  [MISMATCH @ sym%0d sc%0d] golden=%08x rtl=%08x",
                             i/N_FFT, i%N_FFT, exp, got);
                mismatch_cnt++;
            end
        end
        $fclose(out_fd);

        $display("");
        $display("  比对: %0d 点, 失配 %0d", nsym*N_FFT, mismatch_cnt);
        write_evidence(nsym*N_FFT, mismatch_cnt);
        if (mismatch_cnt != 0)
            $fatal(1, "CHEST COSIM FAILED — %0d mismatches", mismatch_cnt);
        $display("================================================");
        $display("  CHEST COSIM PASSED — bit-true");
        $display("================================================");
        $finish;
    end

endmodule
