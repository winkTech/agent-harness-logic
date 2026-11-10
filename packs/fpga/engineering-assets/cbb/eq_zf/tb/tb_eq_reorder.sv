//==============================================================================
// tb_eq_reorder — 子载波序重排的判据 TB (写在 eq_reorder.sv 之前)
//
// 为什么要重排: rx_chain.m 第 3 步按 cfg.data_idx(d) 逐个取 bin, 再把 data_sym(:)
// 喂给 mod_demapper; 发端 subcarrier_map 用同一个序放数据 —— **比特与子载波的对应
// 关系就是由这个序定义的**, 换序等于把比特打乱。而硬件顺着 fft64_sdf 的输出流只能
// 按 bin 升序出, 所以必须有人转。
//
// 升序   = bin [1..6, 8..20, 22..26, 38..42, 44..56, 58..63]  (前 24 个是正子载波)
// golden = bin [38..42, 44..56, 58..63, 1..6, 8..20, 22..26]  (cfg.data_idx 序)
// 两者恰是**左旋 24**, 故判据用闭式: 出[p] == 入[(p+24) % 48]。
//
// 运行 (从 rtl/ 目录):
//   iverilog -g2012 -o tb.out ../tb/tb_eq_reorder.sv eq_reorder.sv && vvp tb.out
//==============================================================================
`default_nettype none
`timescale 1ns/1ps

module tb_eq_reorder;

    localparam int DATA_W = 16;
    localparam int ND     = 48;
    localparam int ROT    = 24;
    localparam int NSYM   = 6;

    logic i_clk = 1'b0, i_rst = 1'b1;
    always #5 i_clk = ~i_clk;

    logic        i_valid = 1'b0, i_er = 1'b0;
    logic [31:0] i_data  = '0;
    logic [11:0] i_conf  = '0;
    wire         o_ready;

    wire         m_tvalid;
    logic        m_tready = 1'b1;
    wire  [31:0] m_tdata;
    wire  [11:0] m_conf;
    wire         m_er;

    eq_reorder #(.DATA_W(DATA_W), .P_NDATA(ND), .P_ROT(ROT)) dut (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(i_valid), .o_ready(o_ready), .i_data(i_data),
        .i_conf(i_conf), .i_erasure(i_er),
        .m_axis_tvalid(m_tvalid), .m_axis_tready(m_tready),
        .m_axis_tdata(m_tdata), .o_conf(m_conf), .o_erasure(m_er));

    // 激励用可辨识序列: 第 s 个符号的第 j 点 = {s, j}, 一眼能看出串没串
    function automatic logic [31:0] mk(input int s, input int j);
        mk = {16'(s), 16'(j)};
    endfunction

    int  sent = 0, got = 0, fails = 0, mism = 0;
    logic [31:0] cap [0:NSYM*ND-1];
    logic [11:0] cap_cf [0:NSYM*ND-1];
    bit  cap_er [0:NSYM*ND-1];

    task automatic chk(input bit ok, input string what);
        if (!ok) begin fails++; $display("  [FAIL] %s", what); end
        else            $display("  [ok]   %s", what);
    endtask

    always @(posedge i_clk) begin
        if (!i_rst && m_tvalid && m_tready) begin
            if (got < NSYM*ND) begin
                cap[got]    <= m_tdata;
                cap_cf[got] <= m_conf;
                cap_er[got] <= m_er;
            end
            got <= got + 1;
        end
    end

    // 送一个符号 (升序 j = 0..47); erasure 打在 j==3 上, 查它是否跟着数据一起旋转
    task automatic push_sym(input int s);
        int j;
        j = 0;
        while (j < ND) begin
            @(negedge i_clk);
            i_valid = 1'b1;
            i_data  = mk(s, j);
            i_conf  = 12'(j) | 12'h800;          // 带一位固定标记, 免得与 0 混淆
            i_er    = (j == 3);
            if (o_ready) begin j = j + 1; sent = sent + 1; end
        end
        @(negedge i_clk);
        i_valid = 1'b0; i_er = 1'b0;
    endtask

    // 出侧 tready 模式
    int rd_mode = 0;
    always @(negedge i_clk) begin
        case (rd_mode)
            1: m_tready <= (($urandom % 4) != 0);
            2: m_tready <= ((($time/10) % 60) < 40);
            3: m_tready <= ~m_tready;
            default: m_tready <= 1'b1;
        endcase
    end

    int exp_s, exp_j;
    logic [31:0] ref_all [0:NSYM*ND-1];
    bit  same;

    task automatic run_all(input int md);
        i_rst = 1'b1; rd_mode = 0;
        repeat (4) @(negedge i_clk);
        sent = 0; got = 0; mism = 0;
        i_rst = 1'b0;
        @(negedge i_clk);
        rd_mode = md;
        for (int s = 0; s < NSYM; s++) push_sym(s);
        repeat (600) @(posedge i_clk);
        rd_mode = 0;
        repeat (4) @(negedge i_clk);
    endtask

    initial begin
        //---- T1/T2 无反压: 闭式逐点比对, 覆盖多符号不串 ----
        run_all(0);
        chk(got == NSYM*ND, $sformatf("T5 送入 %0d 出 %0d (不得丢点)", sent, got));
        for (int k = 0; k < NSYM*ND; k++) begin
            exp_s = k / ND;
            exp_j = (k % ND + ROT) % ND;               // 出[p] = 入[(p+24)%48]
            if (cap[k] !== mk(exp_s, exp_j)) begin
                if (mism < 5)
                    $display("  [X] #%0d 得 %08X 期望 %08X", k, cap[k], mk(exp_s, exp_j));
                mism++;
            end
            if (cap_er[k] !== (exp_j == 3)) begin
                if (mism < 5) $display("  [ER] #%0d er=%b 期望 %b", k, cap_er[k], (exp_j == 3));
                mism++;
            end
            // conf 必须与 data **同步旋转**。单独盯它: 若它没跟着转, 数据判据仍会全绿,
            // 而权重已经配到别的载波上 —— 那种错在链路上只表现为 BER 略差。
            if (cap_cf[k] !== (12'(exp_j) | 12'h800)) begin
                if (mism < 5)
                    $display("  [CF] #%0d conf=%03X 期望 %03X", k, cap_cf[k], 12'(exp_j) | 12'h800);
                mism++;
            end
        end
        chk(mism == 0, $sformatf("T1/T2 闭式重排 (出[p]==入[(p+24)%%48]) 多符号不串: 失配 %0d", mism));
        for (int k = 0; k < NSYM*ND; k++) ref_all[k] = cap[k];

        //---- T3 三种出侧反压: 与基准逐点相同 ----
        for (int md = 1; md <= 3; md++) begin
            same = 1'b1;
            run_all(md);
            if (got != NSYM*ND) same = 1'b0;
            for (int k = 0; k < NSYM*ND; k++) if (cap[k] !== ref_all[k]) same = 1'b0;
            chk(same, $sformatf("T3 反压模式 %0d 与基准逐点相同 (出 %0d)", md, got));
        end

        //---- T4 符号中途复位: 不得残留半个旧符号 ----
        i_rst = 1'b1; rd_mode = 0;
        repeat (4) @(negedge i_clk);
        sent = 0; got = 0;
        i_rst = 1'b0;
        @(negedge i_clk);
        push_sym(9);                                    // 完整一个符号
        repeat (20) @(posedge i_clk);
        i_rst = 1'b1;                                   // 中途复位
        repeat (6) @(posedge i_clk);
        chk(m_tvalid === 1'b0, "T4a 复位期间 m_axis_tvalid 为 0");
        repeat (4) @(negedge i_clk);

        run_all(0);
        mism = 0;
        for (int k = 0; k < NSYM*ND; k++) begin
            exp_s = k / ND;
            exp_j = (k % ND + ROT) % ND;
            if (cap[k] !== mk(exp_s, exp_j)) mism++;
        end
        chk(got == NSYM*ND && mism == 0,
            $sformatf("T4b 复位后重入从新符号第 0 点起 (出 %0d, 失配 %0d)", got, mism));

        $display("");
        if (fails != 0) begin
            $display("RESULT: FAIL - tb_eq_reorder (%0d 条未过)", fails);
            $fatal(1, "tb_eq_reorder: %0d 条判据未过", fails);
        end
        $display("RESULT: PASS - tb_eq_reorder");
        $finish;
    end

endmodule

`default_nettype wire
