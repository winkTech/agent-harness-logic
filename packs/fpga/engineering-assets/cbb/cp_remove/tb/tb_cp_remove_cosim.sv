//==============================================================================
// tb_cp_remove_cosim — 对 golden 的 **0 容差** 位真对拍
//
// 与 tb_cp_remove 的分工: 那个用编码下标的合成流验证切窗序列本身 (错位可直接读出
// 偏了多少); 本 TB 用**真实信号**走完整链路并与 golden 逐点比对。
//
// 向量来源: models/comm/ofdm 的 src/rx_cp_window.m —— **治理资产**, 非暂存副本。
//   输入流 = [STS 160][GI2 32][T1 64][T2 64][数据 32x80], 前导取自
//   models/comm/synch 的 generate_preamble (引 IEEE 802.11a-1999 §17.3.3),
//   数据符号取自 tx_chain; 整流经 AGC 缩到刚好不削 Q2.14 后量化。
//   fft_start 指向 T1 首样点 (0-based 192), 与 sync_top 的 o_fft_start 同语义。
//   期望 = 34 个符号 x 64 点 (2 个 LTS + 32 个数据符号) = 2176 点。
//   长度取 32 符号而非 8: G-B-03 的 total 下限是 2048 输出点, 8 符号只有 640。
//
// 判据: 逐点相等。切窗是纯选通逻辑, 无算术, 不存在容差空间。
// 反假绿: 失配或比对点数不足即 $fatal(1)。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_cp_remove_cosim;

    localparam int DATA_W     = 16;
    localparam int N_IN       = 2880;
    localparam int FFT_START0 = 192;    // 0-based, T1 首样点
    localparam int NSYM       = 32;
    localparam int N_OUT      = 2176;   // (2 + NSYM) * 64, 越过 G-B-03 的 2048 下限
    localparam int N_FLUSH    = 64;     // 帧尾冲刷 (1.1.0), 不进 golden 判据

    logic i_clk = 1'b0, i_rst = 1'b1;
    logic i_fft_start = 1'b0;
    logic [7:0] i_cfg_n_sym = NSYM;
    logic s_valid = 1'b0;
    logic [DATA_W*2-1:0] s_data = '0;

    logic o_valid, o_sb;
    logic signed [DATA_W-1:0] o_re, o_im;

    logic [31:0] vec_in  [0:N_IN-1];
    logic [31:0] vec_exp [0:N_OUT-1];

    int mism = 0, fmism = 0, cmpd = 0, sb_cnt = 0, sb_pos = -1;
    // 流水偏移: i_fft_start 那一拍到首个 o_valid 的时钟数, 实测记录 (不参与判定,
    // 对齐按 valid 握手, 无人工偏移)。G-B-03 证据里的 pipeline_offset 取此值。
    int t_start = -1, t_first = -1, tick = 0;
    string vdir;

    always #5 i_clk = ~i_clk;

    cp_remove #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_fft_start(i_fft_start), .i_cfg_n_sym(i_cfg_n_sym),
        .s_axis_tvalid(s_valid), .s_axis_tdata(s_data),
        .o_valid(o_valid), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    always @(posedge i_clk) begin
        tick <= tick + 1;
        if (!i_rst && i_fft_start && t_start < 0) t_start <= tick;
        if (!i_rst && o_valid && t_first < 0)     t_first <= tick;
        if (!i_rst && o_valid) begin
            if (cmpd < N_OUT) begin
                // 前 N_OUT 点: 对治理 golden 的切窗输出 0 容差
                if ({o_im, o_re} !== vec_exp[cmpd]) begin
                    if (mism < 10)
                        $display("  [MISMATCH] #%0d 期望 %08X 实得 %08X", cmpd, vec_exp[cmpd], {o_im, o_re});
                    mism <= mism + 1;
                end
            end else if (cmpd < N_OUT + N_FLUSH) begin
                // 其后 N_FLUSH 点: 帧尾冲刷。**不进 golden 判据** —— 冲刷不是切窗
                // 语义, 不该塞进 802.11a 的切窗参考模型。但它也不能没人管, 故在此
                // 逐拍钉死必须为零。
                if ({o_im, o_re} !== 32'h0000_0000) begin
                    if (fmism < 10)
                        $display("  [FLUSH-MISMATCH] 冲刷第 %0d 拍应为 0, 实得 %08X", cmpd - N_OUT, {o_im, o_re});
                    fmism <= fmism + 1;
                end
            end
            if (o_sb) begin
                if (sb_pos < 0) sb_pos <= cmpd;
                sb_cnt <= sb_cnt + 1;
            end
            cmpd <= cmpd + 1;
        end
    end

    initial begin
        if (!$value$plusargs("VEC_DIR=%s", vdir))
            vdir = "c:/Users/Lihan/.claude/engineering-assets/cbb/cp_remove/vectors";
        $readmemh({vdir, "/cp_in.hex"},       vec_in);
        $readmemh({vdir, "/cp_expected.hex"}, vec_exp);

        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        for (int n = 0; n < N_IN; n++) begin
            @(negedge i_clk);
            s_valid     = 1'b1;
            i_fft_start = (n == FFT_START0);
            s_data      = vec_in[n];
        end
        @(negedge i_clk);
        s_valid = 1'b0; i_fft_start = 1'b0;
        // 帧尾冲刷是自驱的 (撤 s_valid 后仍会吐满 64 拍), 收尾必须等够
        repeat (N_FLUSH + 20) @(negedge i_clk);

        if (cmpd != N_OUT + N_FLUSH)
            $fatal(1, "TB_FAIL: 输出 %0d 点, 期望 %0d (切窗 %0d + 冲刷 %0d) —— 点数不符也算失败",
                   cmpd, N_OUT + N_FLUSH, N_OUT, N_FLUSH);
        if (mism != 0)
            $fatal(1, "TB_FAIL: bit-true 对拍 %0d/%0d 点失配", mism, N_OUT);
        if (fmism != 0)
            $fatal(1, "TB_FAIL: 帧尾冲刷 %0d/%0d 拍非零", fmism, N_FLUSH);
        if (sb_pos != 0 || sb_cnt != 1)
            $fatal(1, "TB_FAIL: 侧带应只在第 0 个输出打一次, 实为 pos=%0d cnt=%0d", sb_pos, sb_cnt);

        $display("PIPELINE_OFFSET %0d", t_first - t_start);
        $display("RESULT: PASS - tb_cp_remove_cosim, 0 errors (对治理 golden bit-true %0d 点 0 失配 + 帧尾冲刷 %0d 拍全零)",
                 N_OUT, N_FLUSH);
        $finish;
    end

endmodule

`default_nettype wire
