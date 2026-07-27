`timescale 1ns / 1ps
`default_nettype none
//==============================================================================
// tb_ddr_axi4_controller — ddr_axi4_controller 自检 TB
// 参考模型: TB 内建行为级 AXI4 从机 (关联数组存储器, 随机通道退避) +
//           期望存储器镜像 (写命令时并行写入, 读回逐拍比对)。
// 场景 (对应 var/gates/verification-quality.json):
//   S1 基础: 随机读写事务混合 (len 1..16), 写后读回全比对 0 失配。
//   S2 背压: 从机随机撤 awready/wready/arready + 延迟 bvalid/rvalid;
//      判据 = AXI 通道 valid && !ready 期间载荷稳定 (逐拍采样断言)。
//   S3 边界: len=1 与 len=P_TB_MAX_LEN 定向; 背靠背命令。
//   S4 复位: 运行中复位后 o_busy/o_err 清零, 新命令正常完成。
//   S5 超时+错误: 从机故意不响应 AR → o_err 置位且粘滞, 恢复响应后
//      新命令成功并清 err; bresp=SLVERR 注入 → o_err 置位。
// 反假绿: X/Z 计失配; 比较计数 0 则 $fatal; 失配打印期望/实际并 $fatal。
//==============================================================================
module tb_ddr_axi4_controller;

    localparam int DW = 64;
    localparam int AW = 32;
    localparam int IDW = 4;
    localparam int TB_MAX_LEN = 16;
    localparam int TIMEOUT = 256;

    logic clk = 1'b0;
    always #5 clk = ~clk;

    int n_err = 0;
    int n_cmp = 0;

    //==========================================================================
    // DUT 接口
    //==========================================================================
    logic rst, calib;
    logic cmd_valid, cmd_ready, cmd_write;
    logic [AW-1:0] cmd_addr;
    logic [8:0]    cmd_len;
    logic wr_valid, wr_ready;
    logic [DW-1:0] wr_data;
    logic rd_valid, rd_last;
    logic [DW-1:0] rd_data;
    logic busy, err;

    logic [IDW-1:0] awid;   logic [AW-1:0] awaddr; logic [7:0] awlen;
    logic [2:0] awsize;     logic [1:0] awburst;   logic awvalid, awready;
    logic [DW-1:0] wdata;   logic [DW/8-1:0] wstrb; logic wlast, wvalid, wready;
    logic [IDW-1:0] bid;    logic [1:0] bresp;     logic bvalid, bready;
    logic [IDW-1:0] arid;   logic [AW-1:0] araddr; logic [7:0] arlen;
    logic [2:0] arsize;     logic [1:0] arburst;   logic arvalid, arready;
    logic [IDW-1:0] rid;    logic [DW-1:0] rdata_s; logic [1:0] rresp;
    logic rlast, rvalid, rready;

    ddr_axi4_controller #(
        .P_DATA_W(DW), .P_ADDR_W(AW), .P_ID_W(IDW), .P_TIMEOUT(TIMEOUT)
    ) u_dut (
        .i_clk(clk), .i_rst(rst), .i_calib_done(calib),
        .i_cmd_valid(cmd_valid), .o_cmd_ready(cmd_ready),
        .i_cmd_write(cmd_write), .i_cmd_addr(cmd_addr), .i_cmd_len(cmd_len),
        .i_wr_valid(wr_valid), .o_wr_ready(wr_ready), .i_wr_data(wr_data),
        .o_rd_valid(rd_valid), .o_rd_last(rd_last), .o_rd_data(rd_data),
        .o_busy(busy), .o_err(err),
        .m_axi_awid(awid), .m_axi_awaddr(awaddr), .m_axi_awlen(awlen),
        .m_axi_awsize(awsize), .m_axi_awburst(awburst),
        .m_axi_awvalid(awvalid), .m_axi_awready(awready),
        .m_axi_wdata(wdata), .m_axi_wstrb(wstrb), .m_axi_wlast(wlast),
        .m_axi_wvalid(wvalid), .m_axi_wready(wready),
        .m_axi_bid(bid), .m_axi_bresp(bresp), .m_axi_bvalid(bvalid), .m_axi_bready(bready),
        .m_axi_arid(arid), .m_axi_araddr(araddr), .m_axi_arlen(arlen),
        .m_axi_arsize(arsize), .m_axi_arburst(arburst),
        .m_axi_arvalid(arvalid), .m_axi_arready(arready),
        .m_axi_rid(rid), .m_axi_rdata(rdata_s), .m_axi_rresp(rresp),
        .m_axi_rlast(rlast), .m_axi_rvalid(rvalid), .m_axi_rready(rready)
    );

    //==========================================================================
    // 行为级 AXI4 从机 (单事务, 存储器映射, 随机退避)
    //==========================================================================
    logic [DW-1:0] slave_mem [logic [AW-1:0]];
    int  slv_ready_pct   = 70;    // 各 ready 置位概率
    bit  slv_ar_mute     = 1'b0;  // S5: 拒绝响应 AR (制造超时)
    bit  slv_inject_slverr = 1'b0;

    // 写侧从机
    logic [AW-1:0] s_waddr;
    logic [7:0]    s_wlen;
    initial begin : slave_write
        awready = 1'b0; wready = 1'b0; bvalid = 1'b0;
        bid = '0; bresp = 2'b00;
        forever begin
          // 复位看护: S4 复位丢弃在途事务是 DUT 契约, 从机须同步中止协议
          // 上下文 (只复位 DUT 会让从机卡在旧事务的 W/B 相位吞掉新事务)。
          fork
            begin : wr_xact
            // AW — negedge 等待 (post-NBA 稳定值), posedge fire + 采样 (pre-NBA
            // 恰为成交载荷)。若在 posedge 后的 active region 判 valid, 读到的是
            // 旧值残影, TB 侧有气泡时会幻影计拍 —— 本 TB 首版实测踩中。
            awready = 1'b0;
            @(negedge clk);
            while (awvalid !== 1'b1) @(negedge clk);
            while ($urandom_range(0, 99) >= slv_ready_pct) @(negedge clk);
            awready = 1'b1;
            @(posedge clk);                    // fire
            s_waddr = awaddr; s_wlen = awlen;
            @(negedge clk);
            awready = 1'b0;
            // W: 收 awlen+1 拍
            for (int k = 0; k <= s_wlen; k++) begin
                wready = 1'b0;
                @(negedge clk);
                while (wvalid !== 1'b1) @(negedge clk);
                while ($urandom_range(0, 99) >= slv_ready_pct) @(negedge clk);
                wready = 1'b1;
                @(posedge clk);                // fire
                slave_mem[s_waddr + k * (DW/8)] = wdata;
                if (wlast !== (k == s_wlen)) begin
                    n_err++;
                    $display("FAIL[AXI-W]: 第 %0d/%0d 拍 wlast=%b 违反协议", k, s_wlen, wlast);
                end
                @(negedge clk);
                wready = 1'b0;
            end
            // B
            repeat ($urandom_range(1, 5)) @(posedge clk);
            bresp  = slv_inject_slverr ? 2'b10 : 2'b00;
            bvalid = 1'b1;
            @(posedge clk);
            while (!(bready === 1'b1)) @(posedge clk);
            bvalid = 1'b0;
            end
            begin : wr_rst_watch
                wait (rst === 1'b1);
            end
          join_any
          disable fork;
          awready = 1'b0; wready = 1'b0; bvalid = 1'b0;
          if (rst === 1'b1) wait (rst === 1'b0);
        end
    end

    // 读侧从机
    logic [AW-1:0] s_raddr;
    logic [7:0]    s_rlen;
    initial begin : slave_read
        arready = 1'b0; rvalid = 1'b0;
        rid = '0; rresp = 2'b00; rlast = 1'b0; rdata_s = '0;
        forever begin
          fork
            begin : rd_xact
            arready = 1'b0;
            @(negedge clk);
            while (arvalid !== 1'b1) @(negedge clk);
            if (slv_ar_mute) begin
                // S5: 保持沉默直到超时场景解除; 结束本次事务体 (外层重启),
                // 不握手 —— DUT 已超时放弃
                while (slv_ar_mute) @(negedge clk);
                disable rd_xact;
            end
            while ($urandom_range(0, 99) >= slv_ready_pct) @(negedge clk);
            arready = 1'b1;
            @(posedge clk);                    // fire
            s_raddr = araddr; s_rlen = arlen;
            @(negedge clk);
            arready = 1'b0;
            for (int k = 0; k <= s_rlen; k++) begin
                repeat ($urandom_range(0, 3)) @(posedge clk);
                rdata_s = slave_mem.exists(s_raddr + k * (DW/8))
                        ? slave_mem[s_raddr + k * (DW/8)] : '0;
                rlast   = (k == s_rlen);
                rvalid  = 1'b1;
                @(posedge clk);
                while (!(rready === 1'b1)) @(posedge clk);
                rvalid = 1'b0; rlast = 1'b0;
            end
            end
            begin : rd_rst_watch
                wait (rst === 1'b1);
            end
          join_any
          disable fork;
          arready = 1'b0; rvalid = 1'b0; rlast = 1'b0;
          if (rst === 1'b1) wait (rst === 1'b0);
        end
    end

    //==========================================================================
    // AXI 稳定性检查: valid && !ready 期间载荷不得变化 (S2 判据)
    //==========================================================================
    logic [AW-1:0] p_awaddr; logic [7:0] p_awlen; logic p_awv;
    logic [DW-1:0] p_wdata;  logic p_wlast, p_wv;
    logic [AW-1:0] p_araddr; logic [7:0] p_arlen; logic p_arv;

    always @(posedge clk) if (!rst) begin
        if (p_awv && awvalid && !awready
            && (awaddr !== p_awaddr || awlen !== p_awlen)) begin
            n_err++; $display("FAIL[AXI-AW]: valid&&!ready 期间载荷变化");
        end
        if (p_wv && wvalid && !wready
            && (wdata !== p_wdata || wlast !== p_wlast)) begin
            n_err++; $display("FAIL[AXI-W]: valid&&!ready 期间载荷变化");
        end
        if (p_arv && arvalid && !arready
            && (araddr !== p_araddr || arlen !== p_arlen)) begin
            n_err++; $display("FAIL[AXI-AR]: valid&&!ready 期间载荷变化");
        end
        p_awv <= awvalid && !awready; p_awaddr <= awaddr; p_awlen <= awlen;
        p_wv  <= wvalid  && !wready;  p_wdata  <= wdata;  p_wlast <= wlast;
        p_arv <= arvalid && !arready; p_araddr <= araddr; p_arlen <= arlen;
    end else begin
        p_awv <= 1'b0; p_wv <= 1'b0; p_arv <= 1'b0;
    end

    //==========================================================================
    // 驱动任务 + 期望存储器镜像
    //==========================================================================
    logic [DW-1:0] exp_mem [logic [AW-1:0]];

    task automatic do_write(input logic [AW-1:0] addr, input int len);
        logic [DW-1:0] beats [$];
        // 命令
        @(negedge clk);
        cmd_valid = 1'b1; cmd_write = 1'b1; cmd_addr = addr; cmd_len = 9'(len);
        do @(posedge clk); while (!(cmd_ready === 1'b1));
        @(negedge clk); cmd_valid = 1'b0;
        // 写数据流
        for (int k = 0; k < len; k++) begin
            logic [DW-1:0] d = {$urandom(), $urandom()};
            beats.push_back(d);
            @(negedge clk);
            wr_valid = 1'b1; wr_data = d;
            do @(posedge clk); while (!(wr_ready === 1'b1));
            @(negedge clk); wr_valid = 1'b0;
            repeat ($urandom_range(0, 2)) @(negedge clk);
        end
        // 完成等待
        do @(posedge clk); while (busy === 1'b1);
        // 镜像
        foreach (beats[k]) exp_mem[addr + k * (DW/8)] = beats[k];
    endtask

    task automatic do_read_check(input logic [AW-1:0] addr, input int len);
        int k;
        @(negedge clk);
        cmd_valid = 1'b1; cmd_write = 1'b0; cmd_addr = addr; cmd_len = 9'(len);
        do @(posedge clk); while (!(cmd_ready === 1'b1));
        @(negedge clk); cmd_valid = 1'b0;
        k = 0;
        while (k < len) begin
            @(posedge clk);
            if (rd_valid === 1'b1) begin
                n_cmp++;
                if ($isunknown(rd_data)
                    || rd_data !== (exp_mem.exists(addr + k*(DW/8)) ? exp_mem[addr + k*(DW/8)] : '0)) begin
                    n_err++;
                    if (n_err <= 10)
                        $display("FAIL[RD]: addr=%h beat=%0d got %h expected %h",
                                 addr, k, rd_data, exp_mem[addr + k*(DW/8)]);
                end
                if ((rd_last === 1'b1) !== (k == len-1)) begin
                    n_err++; $display("FAIL[RD]: rd_last 错位 beat=%0d/%0d", k, len);
                end
                k++;
            end
        end
        do @(posedge clk); while (busy === 1'b1);
    endtask

    task automatic reset_dut();
        rst = 1'b1;
        cmd_valid = 1'b0; wr_valid = 1'b0;
        repeat (4) @(posedge clk);
        @(negedge clk); rst = 1'b0;
        repeat (2) @(posedge clk);
    endtask

    //==========================================================================
    // 主流程
    //==========================================================================
    initial begin : main
        logic [AW-1:0] a;
        int len;
        calib = 1'b0;
        cmd_valid = 1'b0; cmd_write = 1'b0; cmd_addr = '0; cmd_len = '0;
        wr_valid = 1'b0; wr_data = '0;
        reset_dut();

        // 校准未完成时不得接受命令
        @(negedge clk); cmd_valid = 1'b1; cmd_write = 1'b1;
        cmd_addr = 32'h100; cmd_len = 9'd1;
        repeat (10) @(posedge clk);
        if (cmd_ready === 1'b1) begin
            n_err++; $display("FAIL: calib 未完成即置 cmd_ready");
        end
        @(negedge clk); cmd_valid = 1'b0;
        calib = 1'b1;
        repeat (2) @(posedge clk);

        //--- S3 边界: len=1 与 len=TB_MAX_LEN ---------------------------------
        do_write(32'h0000_0000, 1);        do_read_check(32'h0000_0000, 1);
        do_write(32'h0000_1000, TB_MAX_LEN); do_read_check(32'h0000_1000, TB_MAX_LEN);

        //--- S1/S2: 随机事务混合 (从机随机退避已常开) -------------------------
        for (int t = 0; t < 20; t++) begin
            a   = {$urandom_range(0, 255), 8'h00};   // 对齐地址
            len = $urandom_range(1, TB_MAX_LEN);
            do_write(a, len);
            do_read_check(a, len);
        end

        //--- S5a: bresp=SLVERR 注入 → o_err 置位, 下一命令成交后清 -----------
        slv_inject_slverr = 1'b1;
        do_write(32'h0000_2000, 2);
        if (err !== 1'b1) begin
            n_err++; $display("FAIL[S5a]: SLVERR 后 o_err 未置位");
        end
        slv_inject_slverr = 1'b0;
        do_write(32'h0000_2100, 2);
        do_read_check(32'h0000_2100, 2);
        if (err !== 1'b0) begin
            n_err++; $display("FAIL[S5a]: 成功命令后 o_err 未清");
        end

        //--- S5b: AR 静默 → 超时 o_err, 恢复后正常 ---------------------------
        slv_ar_mute = 1'b1;
        @(negedge clk);
        cmd_valid = 1'b1; cmd_write = 1'b0; cmd_addr = 32'h0000_1000; cmd_len = 9'd2;
        do @(posedge clk); while (!(cmd_ready === 1'b1));
        @(negedge clk); cmd_valid = 1'b0;
        // 等超时 (TIMEOUT 拍 + 裕量)
        repeat (TIMEOUT + 50) @(posedge clk);
        if (err !== 1'b1) begin
            n_err++; $display("FAIL[S5b]: AR 超时后 o_err 未置位");
        end
        if (busy !== 1'b0) begin
            n_err++; $display("FAIL[S5b]: 超时后未回到空闲");
        end
        slv_ar_mute = 1'b0;
        repeat (4) @(posedge clk);
        do_read_check(32'h0000_1000, TB_MAX_LEN);   // 恢复后旧数据仍可读
        if (err !== 1'b0) begin
            n_err++; $display("FAIL[S5b]: 恢复命令成功后 o_err 未清");
        end

        //--- S4: 运行中复位 → 恢复 -------------------------------------------
        @(negedge clk);
        cmd_valid = 1'b1; cmd_write = 1'b1; cmd_addr = 32'h0000_3000; cmd_len = 9'd4;
        do @(posedge clk); while (!(cmd_ready === 1'b1));
        @(negedge clk); cmd_valid = 1'b0;
        repeat (2) @(posedge clk);          // 事务进行中
        reset_dut();
        if (busy !== 1'b0 || err !== 1'b0) begin
            n_err++; $display("FAIL[S4]: 复位后 busy/err 未清");
        end
        do_write(32'h0000_4000, 4);
        do_read_check(32'h0000_4000, 4);

        //--- 判定 -------------------------------------------------------------
        if (n_cmp == 0) begin
            $display("FATAL: 比较计数为 0 — TB 空载, 不得作为证据");
            $fatal(1);
        end
        $display("========================================================");
        if (n_err == 0) begin
            $display("[PASS] tb_ddr_axi4_controller");
            $display("       读回比对 %0d 拍 0 失配 (随机退避从机)", n_cmp);
            $display("       AXI 稳定性/协议 wlast/边界/复位/超时/SLVERR 全过");
        end else begin
            $display("[FAIL] tb_ddr_axi4_controller: %0d 处失配/错误", n_err);
            $fatal(1);
        end
        $display("========================================================");
        $finish;
    end

    initial begin
        #10ms;
        $display("FATAL: TB 看门狗超时");
        $fatal(1);
    end

endmodule
`default_nettype wire
