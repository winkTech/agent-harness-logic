//==============================================================================
// tx_cp_insert — CP 插入 (乒乓, 重写修 0.1.0 F2/F3/F4; ADR-004)
// 功能: 写侧接 IFFT 位反序输出流, 按 bitrev(o_idx) 写地址还原自然序
//       (吸收重排, 零额外延迟); 每符号 64 写满后转待读; 读侧每符号发
//       80 拍: 先 CP (自然序样点 48..63) 再本体 (0..63), m_axis 语义
//       (tvalid 不依赖 tready, 反压冻结读流水)。
//       o_sym_done = 每符号最后一拍被收走 (单拍脉冲, 顶层信用回执)。
// 乒乓: 写 bank 每满切换, 读 bank 每符号完成切换; 待读数 r_rpend<=2
//       由顶层符号信用保证不溢 (o_ovf 为断言辅助)。
// 复位: 同步高有效, 控制链复位; RAM/读数据寄存不复位 (§1.1/§10.2)
//==============================================================================
module tx_cp_insert #(
    parameter int DATA_W = 16,
    parameter int P_CP   = 16
)(
    input  logic                     i_clk,
    input  logic                     i_rst,       // 同步复位, 高有效

    // 写侧 (IFFT 位反序输出流)
    input  logic                     i_beat,
    input  logic                     i_valid,
    input  logic [5:0]               i_idx,       // 顺序号 n; 写地址 = bitrev(n)
    input  logic signed [DATA_W-1:0] i_re,        // Q3.13
    input  logic signed [DATA_W-1:0] i_im,

    // 读侧 (AXI-S)
    output logic                     m_axis_tvalid,
    input  logic                     m_axis_tready,
    output logic [DATA_W*2-1:0]      m_axis_tdata,
    output logic                     m_axis_tlast,   // 每符号第 80 拍

    output logic                     o_sym_done,  // 符号读完回执 (单拍)
    output logic                     o_ovf        // 待读溢出 (断言辅助)
);

    function automatic logic [5:0] f_bitrev(input logic [5:0] n);
        f_bitrev = {n[0], n[1], n[2], n[3], n[4], n[5]};
    endfunction

    //==========================================================================
    // 写侧
    //==========================================================================
    logic        r_wbank;
    logic [6:0]  r_wcnt;
    logic [31:0] r_mem0 [0:63];
    logic [31:0] r_mem1 [0:63];
    logic        w_wr_done;

    assign w_wr_done = i_beat && i_valid && (r_wcnt == 7'd63);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_wbank <= 1'b0;
            r_wcnt  <= '0;
        end else if (i_beat && i_valid) begin
            if (r_wcnt == 7'd63) begin
                r_wcnt  <= '0;
                r_wbank <= ~r_wbank;
            end else begin
                r_wcnt <= r_wcnt + 1'b1;
            end
        end
    end

    // 写地址先落到 wire 再索引: 函数调用直接做非阻塞赋值左值下标时,
    // ModelSim 10.6c 会用 i_idx 更新后的值 (违反 IEEE 1800 §10.4.2 的
    // active 区求值), 样点会写错一格; 综合侧无此偏差, 属仿真/综合不一致。
    logic [5:0] w_waddr;
    assign w_waddr = f_bitrev(i_idx);

    always_ff @(posedge i_clk) begin
        if (i_beat && i_valid) begin
            if (r_wbank) r_mem1[w_waddr] <= {i_im, i_re};
            else         r_mem0[w_waddr] <= {i_im, i_re};
        end
    end

    //==========================================================================
    // 读侧: 80 拍/符号 (addr: k<16 -> 48+k, 否则 k-16); 统一推进使能 w_adv
    //==========================================================================
    logic       r_rbank, r_ract;
    logic [1:0] r_rpend;
    logic [6:0] r_rcnt;
    logic       w_adv, w_rd_last, w_start;
    logic [5:0] w_raddr;

    logic        ro_tvalid;
    logic [31:0] ro_tdata;
    logic        r_v1;
    logic [31:0] r_rd;

    assign w_adv     = !ro_tvalid || m_axis_tready;
    assign w_rd_last = r_ract && (r_rcnt == 7'd79);
    assign w_start   = (!r_ract || (w_adv && w_rd_last)) &&
                       ((r_rpend + (w_wr_done ? 2'd1 : 2'd0)) != 0);
    assign w_raddr   = (r_rcnt < 7'd16) ? 6'(7'd48 + r_rcnt)
                                        : 6'(r_rcnt - 7'd16);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_rbank <= 1'b0;
            r_ract  <= 1'b0;
            r_rcnt  <= '0;
            r_rpend <= '0;
        end else begin
            r_rpend <= r_rpend + (w_wr_done ? 2'd1 : 2'd0)
                               - (w_start ? 2'd1 : 2'd0);
            if (w_start) begin
                r_ract <= 1'b1;
                r_rcnt <= '0;
                if (r_ract && w_adv && w_rd_last) r_rbank <= ~r_rbank;
            end else if (r_ract && w_adv) begin
                if (w_rd_last) begin
                    r_ract  <= 1'b0;
                    r_rcnt  <= '0;
                    r_rbank <= ~r_rbank;
                end else begin
                    r_rcnt <= r_rcnt + 1'b1;
                end
            end
        end
    end

    // 读流水: RAM 读寄存 -> 输出寄存, 同一 w_adv 门控 (冻结一致)
    // [复位豁免] r_rd 为 RAM 读数据寄存器, 不复位 (§10.2)
    always_ff @(posedge i_clk) begin
        if (w_adv) r_rd <= r_rbank ? r_mem1[w_raddr] : r_mem0[w_raddr];
    end

    logic r_l1, ro_tlast;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_v1 <= 1'b0;
            r_l1 <= 1'b0;
        end else if (w_adv) begin
            r_v1 <= r_ract;
            r_l1 <= r_ract && (r_rcnt == 7'd79);
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_tvalid <= 1'b0;
            ro_tlast  <= 1'b0;
        end else if (w_adv) begin
            ro_tvalid <= r_v1;
            ro_tlast  <= r_l1;
        end
    end

    always_ff @(posedge i_clk) begin
        if (w_adv) ro_tdata <= r_rd;
    end

    // 符号完成回执: 第 80 拍数据被收走 (输出寄存级的最后一拍握手)
    logic [6:0] r_ocnt;
    logic       ro_done;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_ocnt  <= '0;
            ro_done <= 1'b0;
        end else begin
            ro_done <= 1'b0;
            if (ro_tvalid && m_axis_tready) begin
                if (r_ocnt == 7'd79) begin
                    r_ocnt  <= '0;
                    ro_done <= 1'b1;
                end else begin
                    r_ocnt <= r_ocnt + 1'b1;
                end
            end
        end
    end

    // 溢出断言辅助 (顶层信用应使其恒 0)
    logic ro_ovf;
    always_ff @(posedge i_clk) begin
        if (i_rst) ro_ovf <= 1'b0;
        else if (w_wr_done && r_rpend == 2'd2) ro_ovf <= 1'b1;
    end

    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;
    assign m_axis_tlast  = ro_tlast;
    assign o_sym_done    = ro_done;
    assign o_ovf         = ro_ovf;

endmodule : tx_cp_insert
