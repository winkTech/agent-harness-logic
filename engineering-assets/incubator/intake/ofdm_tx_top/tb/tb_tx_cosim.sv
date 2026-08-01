//==============================================================================
// tb_tx_cosim — ofdm_tx_top 与 golden 位真镜像的 0 容差 cosim (G-B-03)
//
// 激励: tx_bits.hex        每行一个比特组 (6 bit, LSB 对齐), 48 组/符号
// 期望: expected_tx.hex    每行一个样点 {Q3.13_Q[15:0], Q3.13_I[15:0]}
// 参数: vector_config.txt  N_FRAME / N_SYM / FRAME<i>_MOD
//   均由 models/comm/ofdm/src/generate_vectors.m 调用 rtl_mirror_tx 产出;
//   镜像按 fixed_point_report §2.2 的缩放调度实现 —— 失配即 RTL 偏离需求。
//
// 判据: **逐位相等, 0 容差**。任一样点不等即失败, 不接受 LSB 容差。
// 产物: alignment-report.json (G-B-03 / G-GATE-01 证据)
//==============================================================================
`timescale 1ns/1ps

module tb_tx_cosim;

    localparam int NFRAME = 4;
    localparam int NSYM   = 8;                  // 4x8x80 = 2560 样点 (门禁下限 2048)
    localparam int NGRP   = NSYM*48;
    localparam int NSAMP  = NSYM*80;

    logic        clk = 0, rst;
    logic [3:0]  cfg_mod;
    logic [5:0]  s_tdata;
    logic        s_tvalid, s_tready;
    logic [31:0] m_tdata;
    logic        m_tvalid, m_tlast;
    logic        m_tready_r = 1'b1;

    always #5 clk = ~clk;

    ofdm_tx_top #(.DATA_W(16)) dut (
        .i_clk          (clk),
        .i_rst          (rst),
        .i_cfg_mod_type (cfg_mod),
        .s_axis_tdata   (s_tdata),
        .s_axis_tvalid  (s_tvalid),
        .s_axis_tready  (s_tready),
        .s_axis_tlast   (1'b0),
        .m_axis_tdata   (m_tdata),
        .m_axis_tvalid  (m_tvalid),
        .m_axis_tready  (m_tready_r),
        .m_axis_tlast   (m_tlast)
    );

    // 向量
    logic [7:0]  vec_bits [0:NFRAME*NGRP-1];
    logic [31:0] vec_exp  [0:NFRAME*NSAMP-1];

    int cap [$];
    always @(posedge clk)
        if (m_tvalid === 1'b1 && m_tready_r === 1'b1) cap.push_back(int'(m_tdata));

    // 流水延迟测量: 首个被接受的输入拍 -> 首个输出拍 (仅记录, 比对按握手对齐)
    int  r_lat_cnt, r_latency;
    bit  r_lat_run, r_lat_done;
    always @(posedge clk) begin
        if (rst) begin
            r_lat_cnt <= 0; r_lat_run <= 1'b0;
        end else begin
            if (s_tvalid && s_tready && !r_lat_run) begin
                r_lat_run <= 1'b1; r_lat_cnt <= 1;
            end else if (r_lat_run && !r_lat_done) begin
                r_lat_cnt <= r_lat_cnt + 1;
            end
            if (r_lat_run && m_tvalid && !r_lat_done) begin
                r_latency  <= r_lat_cnt;
                r_lat_done <= 1'b1;
            end
        end
    end

    task automatic send_group(input logic [5:0] g);
        int unsigned w;
        s_tdata  <= g;
        s_tvalid <= 1'b1;
        w = 0;
        do begin
            @(posedge clk); w++;
            if (w > 5000) $fatal(1, "cosim: s_tready 超时");
        end while (s_tready !== 1'b1);
    endtask

    task automatic reset_dut();
        @(posedge clk);
        rst <= 1'b1;
        repeat (5) @(posedge clk);
        rst <= 1'b0;
        repeat (3) @(posedge clk);
    endtask

    initial begin : p_watchdog
        #100ms;
        $fatal(1, "cosim 看门狗超时");
    end

    initial begin : p_main
        int fd, nerr, tot, first_bad;
        int unsigned w;
        string names [0:3];

        names[0] = "BPSK"; names[1] = "QPSK";
        names[2] = "16QAM"; names[3] = "64QAM";
        $readmemh("tx_bits.hex", vec_bits);
        $readmemh("expected_tx.hex", vec_exp);

        rst = 1'b1; s_tvalid = 1'b0; s_tdata = '0; cfg_mod = 4'd0;
        repeat (6) @(posedge clk);
        rst = 1'b0;
        repeat (3) @(posedge clk);

        tot = 0; first_bad = -1;
        for (int f = 0; f < NFRAME; f++) begin
            reset_dut();
            cfg_mod = 4'(f);
            cap.delete();
            for (int g = 0; g < NGRP; g++)
                send_group(vec_bits[f*NGRP + g][5:0]);
            for (int g = 0; g < 96; g++) send_group(6'd0);   // 尾部冲刷 2 零符号
            s_tvalid <= 1'b0;
            w = 0;
            while (cap.size() < NSAMP) begin
                @(posedge clk); w++;
                if (w > 80000) begin
                    $display("  [%s] 输出超时 %0d/%0d", names[f], cap.size(), NSAMP);
                    break;
                end
            end

            nerr = 0;
            for (int n = 0; n < NSAMP; n++) begin
                if (n >= cap.size() || cap[n] !== int'(vec_exp[f*NSAMP + n])) begin
                    if (nerr < 5)
                        $display("  [%s] n=%0d got=%08x exp=%08x", names[f], n,
                                 (n < cap.size()) ? cap[n] : 32'hxxxxxxxx,
                                 vec_exp[f*NSAMP + n]);
                    nerr++;
                    if (first_bad < 0) first_bad = f*NSAMP + n;
                end
            end
            tot += nerr;
            $display("  [%s] %0d 样点 逐位失配 %0d", names[f], NSAMP, nerr);
        end

        fd = $fopen("alignment-report.json", "w");
        if (fd != 0) begin
            $fwrite(fd, "{\n  \"id\": \"G-B-03.alignment\",\n");
            $fwrite(fd, "  \"method\": \"bit-true cosim vs golden rtl_mirror_tx (0 tolerance, exact 32-bit match on m_axis_tdata)\",\n");
            $fwrite(fd, "  \"golden\": \"models/comm/ofdm/src/rtl_mirror_tx.m\",\n");
            $fwrite(fd, "  \"spec\": \"knowledge/primary/domains/comm/ofdm/fixed_point_report.md 2.2\",\n");
            $fwrite(fd, "  \"tool\": \"Vivado xsim 2023.1\",\n");
            $fwrite(fd, "  \"tb\": \"tb_tx_cosim\",\n");
            $fwrite(fd, "  \"vectors\": \"tx_bits.hex / expected_tx.hex (generate_vectors 位真镜像)\",\n");
            $fwrite(fd, "  \"frames\": %0d,\n", NFRAME);
            $fwrite(fd, "  \"total\": %0d,\n", NFRAME*NSAMP);
            $fwrite(fd, "  \"mismatch\": %0d,\n", tot);
            $fwrite(fd, "  \"first_mismatch_index\": %0d,\n", first_bad);
            $fwrite(fd, "  \"tolerance_lsb\": 0,\n");
            $fwrite(fd, "  \"pipeline_offset\": %0d,\n", r_latency);
            $fwrite(fd, "  \"alignment\": \"by valid handshake (无人工偏移); pipeline_offset 为实测首拍延迟, 仅记录\",\n");
            $fwrite(fd, "  \"bit_true\": %s\n}\n", (tot == 0) ? "true" : "false");
            $fclose(fd);
            $display("  [证据] alignment-report.json mismatches=%0d", tot);
        end

        if (tot != 0) $fatal(1, "cosim 逐位失配 %0d 点", tot);
        $display("COSIM BIT-TRUE PASSED (%0d 样点, 0 容差)", NFRAME*NSAMP);
        $finish;
    end

endmodule : tb_tx_cosim
