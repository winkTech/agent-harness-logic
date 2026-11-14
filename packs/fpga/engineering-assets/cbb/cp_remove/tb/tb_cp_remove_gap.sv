//==============================================================================
// tb_cp_remove_gap — 探测帧间最小间隔 (不是判据 TB, 是**测量** TB)
//
// 动因: 2026-08-04 写 stability 的 stress 场景时发现零间隔背靠背连帧会丢帧。
// 原因在 FSM 的时序约定里: 数据段末点的下一个样点才触发 S_DATA -> S_UNSYNC,
// 而这一拍 r_seg 仍是 S_DATA, 只有 S_UNSYNC 分支才消费 i_fft_start —— 于是
// 与该拍同拍到达的 fft_start 被吞掉。
//
// 本 TB 对 gap = 0..4 逐个测量"下一帧能否起窗", 把最小可用间隔测出来而不是
// 靠读代码猜。输出 GAP <n> <出点数> 供人工与 run_sim.cjs 读取。
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_cp_remove_gap;

    localparam int DATA_W = 16;
    localparam int N      = 64;
    localparam int N_CP   = 16;
    localparam int NSYM   = 2;
    localparam int FRAME  = 2*N + NSYM*(N_CP+N);   // 一帧的输入样点数

    logic i_clk = 1'b0, i_rst = 1'b1;
    logic i_fft_start = 1'b0;
    logic [7:0] i_cfg_n_sym = NSYM;
    logic s_valid = 1'b0;
    logic [DATA_W*2-1:0] s_data = '0;

    logic o_valid, o_sb;
    logic signed [DATA_W-1:0] o_re, o_im;

    int cnt2 = 0;          // 第二帧的输出点数
    int first2 = -1;       // 第二帧首点值
    bit counting2 = 1'b0;

    always #5 i_clk = ~i_clk;

    cp_remove #(.DATA_W(DATA_W)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_fft_start(i_fft_start), .i_cfg_n_sym(i_cfg_n_sym),
        .s_axis_tvalid(s_valid), .s_axis_tdata(s_data),
        .o_valid(o_valid), .o_re(o_re), .o_im(o_im), .o_sb(o_sb));

    // 只数**第二帧的切窗样点** (值 >= 3000)。1.1.0 起帧尾会自驱吐 64 拍零冲刷,
    // 若按"有效拍"计数, 第一帧的冲刷会混进来, 测出的就不是"第二帧起没起窗"了。
    // 样点值即其输入下标, 故按值域过滤最直接。
    always @(posedge i_clk) begin
        if (!i_rst && o_valid && counting2 && int'(o_re) >= 3000) begin
            if (first2 < 0) first2 <= int'(o_re);
            cnt2 <= cnt2 + 1;
        end
    end

    task automatic beat(input int idx, input bit fs);
        @(negedge i_clk);
        s_valid = 1'b1; i_fft_start = fs;
        s_data  = {DATA_W'(-idx), DATA_W'(idx)};
    endtask

    task automatic idle_beat(input int idx);
        @(negedge i_clk);
        s_valid = 1'b1; i_fft_start = 1'b0;      // 仍是有效样点, 只是不打 fft_start
        s_data  = {DATA_W'(-idx), DATA_W'(idx)};
    endtask

    int expect2;

    initial begin
        expect2 = (2 + NSYM) * N;

        for (int gap = 0; gap <= 4; gap++) begin
            // 复位重来
            @(negedge i_clk); s_valid = 1'b0; i_fft_start = 1'b0;
            i_rst = 1'b1; repeat (4) @(negedge i_clk); i_rst = 1'b0;
            @(negedge i_clk);
            cnt2 = 0; first2 = -1; counting2 = 1'b0;

            // 第一帧
            for (int k = 0; k < FRAME; k++) beat(k, (k == 0));
            // 帧间填充 gap 个有效样点 (不打 fft_start)
            for (int k = 0; k < gap; k++) idle_beat(8000 + k);
            // 第二帧: 首拍打 fft_start, 样点从 3000 起。
            // counting2 延后 3 拍才拉高 —— 第一帧还有 2 拍在途输出 (流水偏移 2),
            // 不排掉会把它们算进第二帧, 让"帧丢了没有"看不清。
            for (int k = 0; k < FRAME; k++) begin
                beat(3000 + k, (k == 0));
                if (k == 2) counting2 = 1'b1;
            end
            @(negedge i_clk); s_valid = 1'b0;
            repeat (10) @(negedge i_clk);
            counting2 = 1'b0;

            $display("GAP %0d %0d %0d", gap, cnt2, first2);
        end

        $display("RESULT: PASS - tb_cp_remove_gap (测量 TB, 期望每帧 %0d 点)", expect2);
        $finish;
    end

endmodule

`default_nettype wire
