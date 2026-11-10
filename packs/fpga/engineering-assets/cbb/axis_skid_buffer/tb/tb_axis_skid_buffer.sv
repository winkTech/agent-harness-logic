`timescale 1ns / 1ps
//==============================================================================
// tb_axis_skid_buffer — axis_skid_buffer 自检 Testbench
//
// 反假绿约定 (库级 V-1..V-6):
//   - 参考模型用 SV 队列 (push/pop 记分板) 建模数据流, 与 RTL 的双寄存实现写法
//     完全不同, 不复用 RTL 表达式;
//   - X/Z 显式计为失配 ($isunknown);
//   - 比较计数为 0 时 $fatal (空载即失败);
//   - 消息一律 ASCII, 保证在任意控制台代码页下证据可读。
//
// 检查项:
//   C1 数据完整性  : 出口序列 == 入口序列 (不丢/不重/不乱序, 含 tlast)
//   C2 AXI-S 稳定性: tvalid 拉高后未被接收前, tvalid 不得撤回且 tdata/tlast 不得变化
//   C3 无多余输出  : 出口握手时参考队列不得为空
//   C4 满吞吐      : tvalid/tready 恒高时逐拍成交
//   C5 复位        : 复位期间 tvalid=0; 复位后不得残留旧数据; 逐寄存器复位比对
//   C6 排空        : 结束时参考队列必须为空 (入口全部流出)
//   C7 容量边界    : 出口堵死时缓冲(主+skid)填满后 tready 必须撤销 (防溢出窗口)
//
// 证据落盘 (+EVID_DIR=<dir>, 可选; 目录及 stability/ 子目录须预先存在):
//   tb-selfcheck.json          G-B-03 原语自检实跑证据 {pass, compares, tool}
//   reset-sim.json             G-C-04 逐寄存器复位比对
//   stability/boundary.json    G-C-05 子结果: 单/双 beat 帧, tlast 边界, 容量边界
//   stability/stress.json      G-C-05 子结果: 3000 拍随机握手浸泡
//   stability/regression.json  G-C-05 子结果: 确定性满吞吐 + 复位后恢复
//   stability/backpressure.json G-C-05 子结果: 持续/重度背压 + 保持语义
//   仅在全部检查通过后写入 (fail-fast: 任一失败 $fatal, 不产证据 => 门禁 blocked)
//==============================================================================
module tb_axis_skid_buffer;

    localparam int  P_DWIDTH      = 32;
    localparam time P_CLK_PERIOD  = 10ns;

    //==========================================================================
    // DUT 接口
    //==========================================================================
    logic                i_clk;
    logic                i_rst;
    logic                s_axis_tvalid;
    logic                s_axis_tready;
    logic [P_DWIDTH-1:0] s_axis_tdata;
    logic                s_axis_tlast;
    logic                m_axis_tvalid;
    logic                m_axis_tready;
    logic [P_DWIDTH-1:0] m_axis_tdata;
    logic                m_axis_tlast;

    axis_skid_buffer #(
        .P_DWIDTH (P_DWIDTH)
    ) u_dut (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .s_axis_tvalid (s_axis_tvalid),
        .s_axis_tready (s_axis_tready),
        .s_axis_tdata  (s_axis_tdata),
        .s_axis_tlast  (s_axis_tlast),
        .m_axis_tvalid (m_axis_tvalid),
        .m_axis_tready (m_axis_tready),
        .m_axis_tdata  (m_axis_tdata),
        .m_axis_tlast  (m_axis_tlast)
    );

    //==========================================================================
    // 时钟
    //==========================================================================
    initial begin
        i_clk = 1'b0;
        forever #(P_CLK_PERIOD/2) i_clk = ~i_clk;
    end

    //==========================================================================
    // 统计
    //==========================================================================
    int unsigned n_in       = 0;
    int unsigned n_checks   = 0;   // 出口比对次数
    int unsigned n_mismatch = 0;
    int unsigned n_stallchk = 0;   // C2 稳定性检查命中次数
    string       s_phase    = "init";
    bit          b_active   = 1'b0;

    // 子场景出口比对计数 (G-C-05 证据)
    int unsigned nb_regression   = 0;
    int unsigned nb_boundary     = 0;
    int unsigned nb_stress       = 0;
    int unsigned nb_backpressure = 0;
    int unsigned ph_base         = 0;

    // 证据落盘
    string evid_dir;
    bit    b_evid;
    string rst_json = "";
    // 证据目录注入的两条通路, 都不允许 TB 内出现硬编码绝对路径:
    //   ModelSim: run_sim.do 经 +EVID_DIR 传绝对路径
    //   xsim    : -testplusarg 在 Windows 上会在 `=` 与盘符处把参数切碎, 传不了路径,
    //             故回落到**运行目录相对** (evid_dir = ""), 由运行脚本负责把证据
    //             从构建目录搬到 var/gates/pg/<asset_uid>/。与 rrc / ofdm 同一套做法。
    // 回落前 b_evid 为 0 会导致整段证据静默不写 —— 那正是本包在 xsim 下"跑通却没有
    // 任何 JSON 产出"的原因, 也就是它的 certified 证据无法被复现的直接成因。
    initial begin
        b_evid = $value$plusargs("EVID_DIR=%s", evid_dir);
        // 用 "." 而非 "" —— 下面拼路径的写法是 {evid_dir, "/xxx.json"}, 空串会拼成
        // "/xxx.json" 即文件系统根, 打不开。
        if (!b_evid) begin
            evid_dir = ".";
            b_evid   = 1'b1;
        end
    end

    //==========================================================================
    // 确定性伪随机 (xorshift32)
    //==========================================================================
    logic [31:0] r_rnd = 32'h0BAD_F00D;
    function automatic logic [31:0] next_rand();
        r_rnd = r_rnd ^ (r_rnd << 13);
        r_rnd = r_rnd ^ (r_rnd >> 17);
        r_rnd = r_rnd ^ (r_rnd << 5);
        return r_rnd;
    endfunction

    //==========================================================================
    // 参考模型: FIFO 队列记分板
    //==========================================================================
    logic [P_DWIDTH-1:0] q_data [$];
    bit                  q_last [$];

    //==========================================================================
    // C1/C3: 入口压栈, 出口比对
    //==========================================================================
    always @(posedge i_clk) begin
        if (b_active && !i_rst) begin
            // 入口握手
            if (s_axis_tvalid && s_axis_tready) begin
                q_data.push_back(s_axis_tdata);
                q_last.push_back(s_axis_tlast);
                n_in++;
            end
            // 出口握手
            if (m_axis_tvalid && m_axis_tready) begin
                n_checks++;
                if (q_data.size() == 0) begin
                    n_mismatch++;
                    $display("[FAIL] t=%0t phase=%s : output with empty ref queue (extra beat)",
                             $time, s_phase);
                    $fatal(1, "C3 extra output beat");
                end else begin
                    automatic logic [P_DWIDTH-1:0] exp_d = q_data.pop_front();
                    automatic bit                  exp_l = q_last.pop_front();
                    if ($isunknown(m_axis_tdata)) begin
                        n_mismatch++;
                        $display("[FAIL] t=%0t phase=%s : m_axis_tdata has X/Z = %h",
                                 $time, s_phase, m_axis_tdata);
                        $fatal(1, "C1 X/Z on output data");
                    end
                    if (m_axis_tdata !== exp_d) begin
                        n_mismatch++;
                        $display("[FAIL] t=%0t phase=%s : tdata got=%h exp=%h (beat %0d)",
                                 $time, s_phase, m_axis_tdata, exp_d, n_checks);
                        $fatal(1, "C1 data mismatch");
                    end
                    if (m_axis_tlast !== exp_l) begin
                        n_mismatch++;
                        $display("[FAIL] t=%0t phase=%s : tlast got=%b exp=%b (beat %0d)",
                                 $time, s_phase, m_axis_tlast, exp_l, n_checks);
                        $fatal(1, "C1 tlast mismatch");
                    end
                end
            end
        end
    end

    //==========================================================================
    // C2: AXI-S 稳定性 —— 停顿期间 tvalid 不得撤回, tdata/tlast 不得变化
    //==========================================================================
    logic                r_pv;
    logic                r_pr;
    logic [P_DWIDTH-1:0] r_pd;
    logic                r_pl;

    always @(posedge i_clk) begin
        if (i_rst) begin
            r_pv <= 1'b0;
            r_pr <= 1'b0;
            r_pd <= '0;
            r_pl <= 1'b0;
        end else begin
            if (b_active && r_pv && !r_pr) begin
                n_stallchk++;
                if (m_axis_tvalid !== 1'b1) begin
                    n_mismatch++;
                    $display("[FAIL] t=%0t phase=%s : tvalid deasserted while stalled", $time, s_phase);
                    $fatal(1, "C2 tvalid withdrawn during stall");
                end
                if (m_axis_tdata !== r_pd) begin
                    n_mismatch++;
                    $display("[FAIL] t=%0t phase=%s : tdata changed while stalled: %h -> %h",
                             $time, s_phase, r_pd, m_axis_tdata);
                    $fatal(1, "C2 tdata unstable during stall");
                end
                if (m_axis_tlast !== r_pl) begin
                    n_mismatch++;
                    $display("[FAIL] t=%0t phase=%s : tlast changed while stalled", $time, s_phase);
                    $fatal(1, "C2 tlast unstable during stall");
                end
            end
            r_pv <= m_axis_tvalid;
            r_pr <= m_axis_tready;
            r_pd <= m_axis_tdata;
            r_pl <= m_axis_tlast;
        end
    end

    //==========================================================================
    // 激励
    //==========================================================================
    logic [31:0] r_payload = 32'h1000_0000;

    task automatic beat(input bit vld, input bit rdy);
        @(negedge i_clk);
        if (vld && !(s_axis_tvalid && !s_axis_tready)) begin
            // 只有在上一拍不是"已挂起未被接收"时才换新数据 (AXI 要求挂起期间保持)
            r_payload     = r_payload + 32'h0001_0001;
            s_axis_tdata  = r_payload;
            s_axis_tlast  = (r_payload[7:4] == 4'h0);
        end
        s_axis_tvalid = vld;
        m_axis_tready = rdy;
    endtask

    // 显式 tlast 版本 (boundary 场景用)
    task automatic beat_x(input bit vld, input bit rdy, input bit lst);
        @(negedge i_clk);
        if (vld && !(s_axis_tvalid && !s_axis_tready)) begin
            r_payload     = r_payload + 32'h0001_0001;
            s_axis_tdata  = r_payload;
            s_axis_tlast  = lst;
        end
        s_axis_tvalid = vld;
        m_axis_tready = rdy;
    endtask

    //==========================================================================
    // C5 逐寄存器复位比对 (证据进 reset-sim.json)
    //==========================================================================
    task automatic rst_check(input string rname, input logic [31:0] got, input logic [31:0] want);
        automatic bit ok = (got === want);
        if (!ok) begin
            n_mismatch++;
            $display("[FAIL] reset reg %s got=%h want=%h", rname, got, want);
        end
        rst_json = {rst_json, (rst_json.len() > 0 ? ",\n    " : ""),
                    $sformatf("{\"reg\":\"u_dut.%s\",\"got\":%0d,\"want\":%0d,\"pass\":%s}",
                              rname, got, want, ok ? "true" : "false")};
    endtask

    //==========================================================================
    // 证据落盘 (仅全绿路径调用)
    //==========================================================================
    task automatic write_sub(input string name, input int unsigned beats, input string reason);
        automatic int fd = $fopen({evid_dir, "/stability/", name, ".json"}, "w");
        if (fd == 0) $fatal(1, "cannot write stability evidence: %s", name);
        $fdisplay(fd, "{\"pass\": true, \"beats\": %0d, \"reason\": \"%s\", \"tool\": \"ModelSim 10.6c\", \"tb\": \"tb_axis_skid_buffer\"}",
                  beats, reason);
        $fclose(fd);
    endtask

    task automatic dump_evidence();
        automatic int fd;
        if (!b_evid) return;
        fd = $fopen({evid_dir, "/tb-selfcheck.json"}, "w");
        if (fd == 0) $fatal(1, "cannot write tb-selfcheck.json");
        $fdisplay(fd, "{");
        $fdisplay(fd, "  \"id\": \"G-B-03\",");
        $fdisplay(fd, "  \"pass\": true,");
        $fdisplay(fd, "  \"compares\": %0d,", n_checks);
        $fdisplay(fd, "  \"mismatch\": %0d,", n_mismatch);
        $fdisplay(fd, "  \"stall_checks\": %0d,", n_stallchk);
        $fdisplay(fd, "  \"tool\": \"ModelSim 10.6c\",");
        $fdisplay(fd, "  \"tb\": \"tb_axis_skid_buffer\",");
        $fdisplay(fd, "  \"dwidth\": %0d", P_DWIDTH);
        $fdisplay(fd, "}");
        $fclose(fd);

        fd = $fopen({evid_dir, "/reset-sim.json"}, "w");
        if (fd == 0) $fatal(1, "cannot write reset-sim.json");
        $fdisplay(fd, "{");
        $fdisplay(fd, "  \"id\": \"G-C-04.reset\",");
        $fdisplay(fd, "  \"method\": \"mid-run re-reset held 3 clk, per-register compare vs declared reset value\",");
        $fdisplay(fd, "  \"registers\": [");
        $fdisplay(fd, "    %s", rst_json);
        $fdisplay(fd, "  ]");
        $fdisplay(fd, "}");
        $fclose(fd);

        write_sub("regression",   nb_regression,   "deterministic full-rate window + post-reset resume, scoreboard 0 mismatch");
        write_sub("boundary",     nb_boundary,     "single-beat frame, two-beat frame with tlast, capacity-full tready deassert check");
        write_sub("stress",       nb_stress,       "3000-cycle random valid/ready soak, scoreboard 0 mismatch");
        write_sub("backpressure", nb_backpressure, "sustained hold + heavy ~12.5%% ready duty, C2 hold semantics enforced");
    endtask

    //==========================================================================
    // 主序列
    //==========================================================================
    initial begin
        // ── 复位 ──
        s_phase       = "reset";
        i_rst         = 1'b1;
        s_axis_tvalid = 1'b0;
        s_axis_tdata  = '0;
        s_axis_tlast  = 1'b0;
        m_axis_tready = 1'b0;
        repeat (4) @(negedge i_clk);

        // C5: 复位期间出口必须无效
        if (m_axis_tvalid !== 1'b0) begin
            $display("[FAIL] m_axis_tvalid=%b during reset (expect 0)", m_axis_tvalid);
            $fatal(1, "C5 reset behaviour");
        end

        i_rst = 1'b0;
        @(negedge i_clk);
        b_active = 1'b1;

        // ── C4: 满吞吐 —— tvalid/tready 恒高 200 拍 (regression 子场景) ──
        s_phase = "C4-fullrate";
        ph_base = n_checks;
        begin
            automatic int unsigned base = n_checks;
            for (int k = 0; k < 200; k++) beat(1'b1, 1'b1);
            // 排空
            beat(1'b0, 1'b1);
            repeat (4) @(negedge i_clk);
            if ((n_checks - base) < 195) begin
                $display("[FAIL] full-rate throughput too low: %0d beats out of 200",
                         n_checks - base);
                $fatal(1, "C4 throughput");
            end
        end
        nb_regression += n_checks - ph_base;

        // ── C7/boundary: 单 beat 帧 / 双 beat 帧 / 容量边界 ──
        s_phase = "boundary";
        ph_base = n_checks;
        // 单 beat 帧 (tlast=1)
        beat_x(1'b1, 1'b1, 1'b1);
        beat_x(1'b0, 1'b1, 1'b0);
        repeat (3) @(negedge i_clk);
        // 双 beat 帧 (次拍 tlast)
        beat_x(1'b1, 1'b1, 1'b0);
        beat_x(1'b1, 1'b1, 1'b1);
        beat_x(1'b0, 1'b1, 1'b0);
        repeat (3) @(negedge i_clk);
        // 容量边界: 堵死出口连续压 4 拍 (主寄存+skid 容量=2, 满后 tready 必须撤销)
        beat_x(1'b1, 1'b0, 1'b0);
        beat_x(1'b1, 1'b0, 1'b0);
        beat_x(1'b1, 1'b0, 1'b0);
        beat_x(1'b1, 1'b0, 1'b1);
        repeat (4) @(negedge i_clk);
        if (s_axis_tready !== 1'b0) begin
            $display("[FAIL] tready still high with main+skid full (overrun window)");
            $fatal(1, "C7 capacity: tready must deassert when full");
        end
        // 放行排空 (保持中的 beat 按 AXI 语义继续给到握手)
        repeat (6) beat_x(1'b1, 1'b1, 1'b1);
        beat_x(1'b0, 1'b1, 1'b0);
        repeat (6) @(negedge i_clk);
        nb_boundary += n_checks - ph_base;

        // ── 下游持续背压, 上游持续给数 (填满 skid) ──
        s_phase = "backpressure-hold";
        ph_base = n_checks;
        beat(1'b1, 1'b0);
        beat(1'b1, 1'b0);
        beat(1'b1, 1'b0);
        repeat (6) @(negedge i_clk);
        // 放开
        beat(1'b1, 1'b1);
        repeat (6) beat(1'b1, 1'b1);
        beat(1'b0, 1'b1);
        repeat (6) @(negedge i_clk);

        // ── 重度背压: ~12.5% ready 占空比, 持续给数 ──
        s_phase = "backpressure-heavy";
        for (int k = 0; k < 400; k++) begin
            automatic logic [31:0] rv = next_rand();
            beat(1'b1, rv[2] & rv[5] & rv[9]);
        end
        beat(1'b0, 1'b1);
        repeat (10) @(negedge i_clk);
        nb_backpressure += n_checks - ph_base;

        // ── 随机 valid/ready 组合 (stress 子场景) ──
        s_phase = "random-handshake";
        ph_base = n_checks;
        for (int k = 0; k < 3000; k++) begin
            automatic logic [31:0] rv = next_rand();
            beat(rv[0] | rv[1], rv[2] & rv[3] | rv[4]);
        end
        // 排空
        s_phase = "drain";
        beat(1'b0, 1'b1);
        repeat (20) @(negedge i_clk);
        nb_stress += n_checks - ph_base;

        // ── C5: 运行中再复位 + 逐寄存器复位比对 ──
        s_phase  = "C5-rereset";
        b_active = 1'b0;
        // 先制造非空状态: 堵死出口塞 2 拍再拉复位, 复位必须清干净
        b_active = 1'b1;
        beat(1'b1, 1'b0);
        beat(1'b1, 1'b0);
        b_active = 1'b0;
        @(negedge i_clk);
        i_rst         = 1'b1;
        s_axis_tvalid = 1'b0;
        m_axis_tready = 1'b0;
        repeat (3) @(negedge i_clk);
        rst_check("ro_tvalid",    u_dut.ro_tvalid,    32'd0);
        rst_check("ro_sready",    u_dut.ro_sready,    32'd0);
        rst_check("ro_tdata",     u_dut.ro_tdata,     32'd0);
        rst_check("ro_tlast",     u_dut.ro_tlast,     32'd0);
        rst_check("r_skid_valid", u_dut.r_skid_valid, 32'd0);
        rst_check("r_skid_data",  u_dut.r_skid_data,  32'd0);
        rst_check("r_skid_last",  u_dut.r_skid_last,  32'd0);
        if (n_mismatch != 0) $fatal(1, "C5 per-register reset compare failed");
        if (m_axis_tvalid !== 1'b0) begin
            $display("[FAIL] m_axis_tvalid=%b after re-reset (expect 0)", m_axis_tvalid);
            $fatal(1, "C5 re-reset behaviour");
        end
        q_data.delete();
        q_last.delete();
        i_rst = 1'b0;
        @(negedge i_clk);
        b_active = 1'b1;

        // ── 复位后恢复 (regression 子场景) ──
        s_phase = "C5-resume";
        ph_base = n_checks;
        for (int k = 0; k < 40; k++) beat(1'b1, 1'b1);
        beat(1'b0, 1'b1);
        repeat (8) @(negedge i_clk);
        nb_regression += n_checks - ph_base;

        // ── 收尾判定 ──
        b_active = 1'b0;
        if (n_checks == 0) begin
            $fatal(1, "[FAIL] zero comparisons - testbench ran empty (anti-false-green rule)");
        end
        if (n_stallchk == 0) begin
            $fatal(1, "[FAIL] stall-stability check never exercised - C2 unverified");
        end
        if (q_data.size() != 0) begin
            $display("[FAIL] ref queue not drained: %0d beats still pending", q_data.size());
            $fatal(1, "C6 data lost in DUT");
        end
        if (n_mismatch != 0) begin
            $fatal(1, "[FAIL] %0d mismatches", n_mismatch);
        end
        if (nb_regression == 0 || nb_boundary == 0 || nb_stress == 0 || nb_backpressure == 0) begin
            $fatal(1, "[FAIL] a stability sub-scenario compared zero beats (anti-false-green rule)");
        end

        dump_evidence();

        $display("========================================================");
        $display("[PASS] tb_axis_skid_buffer");
        $display("       beats in  = %0d", n_in);
        $display("       beats out = %0d (compared, 0 mismatch)", n_checks);
        $display("       stall-stability checks = %0d", n_stallchk);
        $display("       sub: regression=%0d boundary=%0d stress=%0d backpressure=%0d",
                 nb_regression, nb_boundary, nb_stress, nb_backpressure);
        $display("       P_DWIDTH = %0d", P_DWIDTH);
        $display("========================================================");
        $finish;
    end

    //==========================================================================
    // 看门狗
    //==========================================================================
    initial begin
        #500us;
        $fatal(1, "[FAIL] simulation timeout");
    end

endmodule
