//==============================================================================
// tb_fft64_cosim — 对 golden 定点镜像的 **0 容差** 位真对拍
//
// 与其它三个 TB 的分工:
//   tb_fft64_sdf_core / _direction / _sdf 用解析判据证明结构、方向、缩放、
//   侧带与输出序**没接错**; 它们证明不了逐位一致。本 TB 才是 bit-true 判据。
//
// 向量来源: golden 定点镜像 rtl_mirror_fft64 (models/comm/ofdm), 真实 OFDM
//   时域符号经 AGC 缩到刚好不削 Q2.14, 40 个符号共 2560 样点 —— 与 ofdm_tx_top
//   认证时的样点量级一致 (门禁下限 2048)。镜像侧实测内部溢出 0、输出饱和 0。
//
// 对齐: 送 64 拍零符号预热 (各级 FIFO 按设计不复位, 首符号会带出未初始化的 X),
//   跳过其输出的前 64 点, 其后逐点 0 容差比对。冲刷长度取 64 的整数倍, 否则
//   SDF 的块边界会错位 (块边界按有效拍划分)。
//
// 向量字序: {re[31:16], im[15:0]} —— **与 cp_remove 的 {im, re} 相反**。写反了
//   不会报错, 只会看起来像"变换方向算反了": 交换 re/im 等价于 z -> j*conj(z),
//   失配模式与频点反转 X[k]->X[-k] 极像 (bin0/bin32 恰好仍匹配)。2026-08-04
//   重生成向量时踩过一次。
//
// 反假绿: 任一失配即 $fatal(1); 且必须真的比够 2560 点, 比不够也算失败。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_fft64_cosim;

    localparam int DATA_W = 16;
    localparam int NSAMP  = 2560;      // 40 符号 x 64
    localparam int PRIME  = 64;        // 预热符号

    logic i_clk = 1'b0, i_rst = 1'b1, i_beat = 1'b1, i_valid = 1'b0, i_sb = 1'b0;
    logic signed [DATA_W-1:0] i_re = '0, i_im = '0;
    logic o_valid, o_sb;
    logic [5:0] o_idx;
    logic signed [DATA_W-1:0] o_re, o_im;

    logic [31:0] vec_in  [0:NSAMP-1];
    logic [31:0] vec_exp [0:NSAMP-1];

    int mism = 0, cmpd = 0, skipped = 0;
    string vdir;

    always #5 i_clk = ~i_clk;

    fft64_sdf #(.DATA_W(DATA_W), .P_DIR(1'b0), .P_NATURAL_OUT(1'b1)) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(o_valid), .o_idx(o_idx), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    // 逐点比对: 先跳过预热符号的 64 点, 其后 0 容差
    always @(posedge i_clk) begin
        if (!i_rst && o_valid) begin
            if (skipped < PRIME) begin
                skipped <= skipped + 1;
            end else if (cmpd < NSAMP) begin
                if ({o_re, o_im} !== vec_exp[cmpd]) begin
                    if (mism < 10)
                        $display("  [MISMATCH] #%0d 期望 %08X 实得 %08X", cmpd, vec_exp[cmpd], {o_re, o_im});
                    mism <= mism + 1;
                end
                cmpd <= cmpd + 1;
            end
        end
    end

    initial begin
        if (!$value$plusargs("VEC_DIR=%s", vdir))
            vdir = "c:/Users/Lihan/.claude/engineering-assets/cbb/fft64_sdf/vectors";
        $readmemh({vdir, "/fft_in.hex"},                vec_in);
        $readmemh({vdir, "/fft_expected_natural.hex"},  vec_exp);

        repeat (4) @(negedge i_clk);
        i_rst = 1'b0;
        @(negedge i_clk);

        // 预热符号 (零)
        for (int n = 0; n < PRIME; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1; i_sb = (n == 0); i_re = '0; i_im = '0;
        end
        // 正式向量: 每 64 拍打一次侧带 (符号首拍)
        for (int n = 0; n < NSAMP; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1;
            i_sb    = ((n % 64) == 0);
            i_re    = vec_in[n][31:16];
            i_im    = vec_in[n][15:0];
        end
        // 冲刷: 64 的整数倍, 且足够把最后一个符号推出重排乒乓
        for (int n = 0; n < 256; n++) begin
            @(negedge i_clk);
            i_valid = 1'b1; i_sb = 1'b0; i_re = '0; i_im = '0;
        end
        i_valid = 1'b0;
        repeat (200) @(negedge i_clk);

        if (cmpd != NSAMP)
            $fatal(1, "TB_FAIL: 只比对了 %0d/%0d 点 —— 比不够也算失败, 不得当成通过", cmpd, NSAMP);
        if (mism != 0)
            $fatal(1, "TB_FAIL: bit-true 对拍 %0d/%0d 点失配", mism, NSAMP);

        $display("RESULT: PASS - tb_fft64_cosim, 0 errors (bit-true %0d 样点 0 失配, 对 golden 镜像)", cmpd);
        $finish;
    end

endmodule

`default_nettype wire
